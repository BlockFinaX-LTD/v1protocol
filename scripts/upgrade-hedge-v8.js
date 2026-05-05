/**
 * upgrade-hedge-v8.js — upgrades HedgeFacet (v7 range product + v8 signed-quote
 * attestation) and OracleFacet (v7 range settlement parity) on a single chain.
 *
 * What this does:
 *   1. Deploys the new HedgeFacet contract (no constructor args)
 *   2. Deploys the new OracleFacet contract
 *   3. For each facet:
 *      - Splits its selectors into Replace (already routed in Diamond) vs Add (brand new)
 *      - Builds the FacetCut[] array
 *   4. Submits diamondCut() in a single transaction
 *   5. Smoke-tests: calls a v8 view function (getPricingEngineSigner) to confirm wiring
 *
 * Diamond proxy address is UNCHANGED. Frontend doesn't need to update CHAIN_DIAMOND_MAP.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-hedge-v8.js --network lisk
 *   npx hardhat run scripts/upgrade-hedge-v8.js --network base
 *   npx hardhat run scripts/upgrade-hedge-v8.js --network bsc
 *
 * Required env vars per network:
 *   DEPLOYER_PRIVATE_KEY
 *   DIAMOND_ADDRESS / BASE_DIAMOND_ADDRESS / BSC_DIAMOND_ADDRESS (auto-picked by chainId)
 *
 * Idempotency note: re-running on the same chain just deploys new facet contracts
 * (more gas burn) and Replaces every selector again. Safe but wasteful.
 */

const hre = require("hardhat");
const { ethers } = hre;

const CHAIN_DIAMOND_ENV = {
  1135: "DIAMOND_ADDRESS",
  8453: "BASE_DIAMOND_ADDRESS",
  56:   "BSC_DIAMOND_ADDRESS",
};

async function getSelectors(contract) {
  return contract.interface.fragments
    .filter(f => f.type === "function")
    .map(f => contract.interface.getFunction(f.name).selector);
}

function getFunctionName(iface, selector) {
  const frag = iface.fragments.find(
    f => f.type === "function" && iface.getFunction(f.name).selector === selector
  );
  return frag ? frag.name : "(unknown)";
}

async function planAndCut(deployer, diamondAddress, facetName, newFacetAddress, newFacetIface) {
  const allSelectors = newFacetIface.fragments
    .filter(f => f.type === "function")
    .map(f => newFacetIface.getFunction(f.name).selector);

  const Loupe = await ethers.getContractAt(
    ["function facetAddress(bytes4 selector) view returns (address)"],
    diamondAddress
  );

  const toReplace = [];
  const toAdd = [];
  for (const sel of allSelectors) {
    const existing = await Loupe.facetAddress(sel);
    if (existing === ethers.ZeroAddress) toAdd.push(sel);
    else toReplace.push(sel);
  }

  console.log(`\n  ${facetName}:  ${allSelectors.length} total selectors  (${toReplace.length} Replace, ${toAdd.length} Add)`);
  if (toAdd.length > 0) {
    console.log("  ── new selectors being added:");
    for (const sel of toAdd) {
      console.log(`     ${sel}  ${getFunctionName(newFacetIface, sel)}`);
    }
  }

  const cuts = [];
  if (toReplace.length > 0) cuts.push({ facetAddress: newFacetAddress, action: 1, functionSelectors: toReplace });
  if (toAdd.length > 0)     cuts.push({ facetAddress: newFacetAddress, action: 0, functionSelectors: toAdd });

  return cuts;
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const envKey = CHAIN_DIAMOND_ENV[chainId];
  if (!envKey) throw new Error(`Unknown chainId ${chainId}; supported: ${Object.keys(CHAIN_DIAMOND_ENV).join(", ")}`);
  const DIAMOND_ADDRESS = process.env[envKey];
  if (!DIAMOND_ADDRESS) throw new Error(`Set ${envKey} env var`);

  const [deployer] = await ethers.getSigners();

  console.log("\n" + "=".repeat(64));
  console.log(" HedgeFacet v8 upgrade — adds range product + signed-quote attestation");
  console.log("=".repeat(64));
  console.log("network:        ", hre.network.name);
  console.log("chainId:        ", chainId);
  console.log("deployer:       ", deployer.address);
  console.log("diamond (proxy):", DIAMOND_ADDRESS);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("deployer bal:   ", ethers.formatEther(balance), "(native)");
  if (balance === 0n) throw new Error("Deployer has zero native balance — top up before deploying.");

  // ── 1. Deploy new facets ─────────────────────────────────────────────────
  console.log("\n1. Deploying new HedgeFacet...");
  const HedgeFactory = await ethers.getContractFactory("BlockFinaXHedgeFacet");
  const newHedge = await HedgeFactory.deploy();
  await newHedge.waitForDeployment();
  const newHedgeAddr = await newHedge.getAddress();
  console.log("   new HedgeFacet:  ", newHedgeAddr);

  console.log("\n2. Deploying new OracleFacet...");
  const OracleFactory = await ethers.getContractFactory("BlockFinaXOracleFacet");
  const newOracle = await OracleFactory.deploy();
  await newOracle.waitForDeployment();
  const newOracleAddr = await newOracle.getAddress();
  console.log("   new OracleFacet: ", newOracleAddr);

  // ── 2. Plan the cut for each facet ───────────────────────────────────────
  console.log("\n3. Planning diamondCut...");
  const hedgeCuts  = await planAndCut(deployer, DIAMOND_ADDRESS, "HedgeFacet",  newHedgeAddr,  HedgeFactory.interface);
  const oracleCuts = await planAndCut(deployer, DIAMOND_ADDRESS, "OracleFacet", newOracleAddr, OracleFactory.interface);

  const allCuts = [...hedgeCuts, ...oracleCuts];
  if (allCuts.length === 0) {
    console.log("\nNo selectors changed — aborting.");
    return;
  }

  // ── 3. Submit ────────────────────────────────────────────────────────────
  console.log("\n4. Executing diamondCut...");
  const DiamondCut = await ethers.getContractAt("BlockFinaXDiamondCutFacet", DIAMOND_ADDRESS);
  const tx = await DiamondCut.diamondCut(allCuts, ethers.ZeroAddress, "0x");
  console.log("   tx hash:", tx.hash);
  const receipt = await tx.wait();
  console.log("   confirmed in block:", receipt.blockNumber, "gas used:", receipt.gasUsed.toString());

  // ── 4. Smoke test ────────────────────────────────────────────────────────
  console.log("\n5. Smoke test — calling v8 view functions on the upgraded Diamond...");
  const Hedge = await ethers.getContractAt("BlockFinaXHedgeFacet", DIAMOND_ADDRESS);
  try {
    const signer = await Hedge.getPricingEngineSigner();
    console.log("   getPricingEngineSigner() =>", signer, signer === ethers.ZeroAddress ? "(unset — legacy mode)" : "(enforcement ON)");
  } catch (e) {
    console.warn("   getPricingEngineSigner() FAILED:", e.message?.slice(0, 100));
  }
  try {
    const fees = await Hedge.getHedgeFeeConfig();
    console.log("   getHedgeFeeConfig() =>", fees.map(b => b.toString()));
  } catch (e) {
    console.warn("   getHedgeFeeConfig() FAILED:", e.message?.slice(0, 100));
  }

  // ── 5. Summary ───────────────────────────────────────────────────────────
  console.log("\n" + "=".repeat(64));
  console.log(" UPGRADE COMPLETE on", hre.network.name);
  console.log("=".repeat(64));
  console.log(`  Diamond (unchanged):  ${DIAMOND_ADDRESS}`);
  console.log(`  new HedgeFacet:       ${newHedgeAddr}`);
  console.log(`  new OracleFacet:      ${newOracleAddr}`);
  console.log("\n  Next: register the pricing-engine signer:");
  console.log(`     npx hardhat run scripts/set-pricing-signer.js --network ${hre.network.name}`);
  console.log("");
}

main().catch((err) => {
  console.error("\nUpgrade failed:", err);
  process.exitCode = 1;
});
