/**
 * rebuild-facet-table.js — atomic Remove+Add cut that fixes the Loupe.
 *
 * Background: LibDiamond.replaceFunctions has a bug — when a Replace cut moves
 * selectors to a brand-new facet address, it pushes the selectors into
 * facetFunctionSelectors[newFacet] but never adds newFacet to the facetAddresses[]
 * array. The result: facetAddress(selector) returns the right address, but
 * facetAddresses() / facets() omit the new facet entirely.
 *
 * After our v8 upgrade, both the new HedgeFacet and the new OracleFacet are
 * "invisible" to Loupe even though they're serving 48 + 12 selectors respectively.
 *
 * Fix: in a single atomic diamondCut, Remove all selectors from the new facets
 * (which empties facetFunctionSelectors[newFacet]), then Add them right back.
 * The Add path correctly calls addFacet() because selectorPosition is 0,
 * pushing the address into facetAddresses[].
 *
 * The Diamond proxy address does NOT change. The new facet contract addresses do
 * NOT change. No new contracts deployed. Just a single corrective cut.
 *
 * Usage:
 *   NEW_HEDGE_FACET=0x... NEW_ORACLE_FACET=0x... \
 *     npx hardhat run scripts/rebuild-facet-table.js --network <lisk|base|bsc>
 */

const hre = require("hardhat");
const { ethers } = hre;

const CHAIN_DIAMOND_ENV = {
  1135: "DIAMOND_ADDRESS",
  8453: "BASE_DIAMOND_ADDRESS",
  56:   "BSC_DIAMOND_ADDRESS",
};

// Facet addresses per chain — pre-populated so this script needs no env vars
// in the common case (just point at the right network).
const FACET_DEFAULTS = {
  1135: { newHedge: "0xbd689fC24A3670B555b72843c4F6CcF170fa634f", newOracle: "0xD9F03c15571aD2E98AD373b1AFdF93C95aA392Ef" },
  8453: { newHedge: "0x9D7F9E4bEC2ddA2F778229048D5374233681fa6f", newOracle: "0x52cA9b99D9a01654505ED291d5df45E6109Cee6f" },
  56:   { newHedge: "0x2813e4a2Bd8d59A75db298a31e2b71191214F203", newOracle: "0x77964366e43a1f2311b04801F37BFb772F84b0F5" },
};

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const envKey = CHAIN_DIAMOND_ENV[chainId];
  const DIAMOND = process.env[envKey];
  if (!DIAMOND) throw new Error(`Set ${envKey}`);

  const defaults = FACET_DEFAULTS[chainId];
  const NEW_HEDGE  = process.env.NEW_HEDGE_FACET  || defaults?.newHedge;
  const NEW_ORACLE = process.env.NEW_ORACLE_FACET || defaults?.newOracle;
  if (!NEW_HEDGE || !NEW_ORACLE) {
    throw new Error("Provide NEW_HEDGE_FACET and NEW_ORACLE_FACET (or use a chain that has FACET_DEFAULTS)");
  }

  const [deployer] = await ethers.getSigners();
  console.log("\n" + "=".repeat(64));
  console.log(" Rebuild facet table — fix Loupe.facetAddresses() observability");
  console.log("=".repeat(64));
  console.log("network:    ", hre.network.name, "chainId:", chainId);
  console.log("diamond:    ", DIAMOND, "(unchanged)");
  console.log("deployer:   ", deployer.address);
  console.log("new HedgeFacet (target):  ", NEW_HEDGE);
  console.log("new OracleFacet (target): ", NEW_ORACLE);

  // Read current facet table — sanity check
  const Loupe = await ethers.getContractAt(
    [
      "function facetFunctionSelectors(address) view returns (bytes4[])",
      "function facetAddresses() view returns (address[])",
    ],
    DIAMOND
  );

  const [hedgeSelectors, oracleSelectors, beforeAddresses] = await Promise.all([
    Loupe.facetFunctionSelectors(NEW_HEDGE),
    Loupe.facetFunctionSelectors(NEW_ORACLE),
    Loupe.facetAddresses(),
  ]);

  console.log("\nCurrent state:");
  console.log("  facetAddresses() count:", beforeAddresses.length);
  console.log("  selectors routed to new HedgeFacet:  ", hedgeSelectors.length);
  console.log("  selectors routed to new OracleFacet: ", oracleSelectors.length);

  const hedgeMissing = !beforeAddresses.map(a => a.toLowerCase()).includes(NEW_HEDGE.toLowerCase());
  const oracleMissing = !beforeAddresses.map(a => a.toLowerCase()).includes(NEW_ORACLE.toLowerCase());
  console.log("  HedgeFacet missing from facetAddresses[]:  ", hedgeMissing);
  console.log("  OracleFacet missing from facetAddresses[]: ", oracleMissing);

  if (!hedgeMissing && !oracleMissing) {
    console.log("\nBoth facets already in facetAddresses[]. Nothing to do.\n");
    return;
  }

  // Build the cuts. We only rebuild the facets that are actually missing.
  // For each: Remove(all current selectors) + Add(all current selectors back to same facet).
  // Action enum: 0=Add, 1=Replace, 2=Remove
  const cuts = [];

  if (hedgeMissing && hedgeSelectors.length > 0) {
    cuts.push({ facetAddress: ethers.ZeroAddress, action: 2, functionSelectors: [...hedgeSelectors] });
    cuts.push({ facetAddress: NEW_HEDGE,           action: 0, functionSelectors: [...hedgeSelectors] });
  }
  if (oracleMissing && oracleSelectors.length > 0) {
    cuts.push({ facetAddress: ethers.ZeroAddress, action: 2, functionSelectors: [...oracleSelectors] });
    cuts.push({ facetAddress: NEW_ORACLE,          action: 0, functionSelectors: [...oracleSelectors] });
  }

  console.log("\nPlanned cut:");
  console.log("  total cut entries:", cuts.length);
  for (const c of cuts) {
    const action = c.action === 2 ? "Remove" : c.action === 0 ? "Add" : "Replace";
    console.log(`    ${action.padEnd(7)} ${c.functionSelectors.length} selectors  →  ${c.facetAddress}`);
  }

  console.log("\nExecuting diamondCut...");
  const Cut = await ethers.getContractAt("BlockFinaXDiamondCutFacet", DIAMOND);
  const tx = await Cut.diamondCut(cuts, ethers.ZeroAddress, "0x");
  console.log("  tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("  confirmed in block:", receipt.blockNumber, "gas used:", receipt.gasUsed.toString());

  // Verify after
  const afterAddresses = await Loupe.facetAddresses();
  const hedgeNow  = afterAddresses.map(a => a.toLowerCase()).includes(NEW_HEDGE.toLowerCase());
  const oracleNow = afterAddresses.map(a => a.toLowerCase()).includes(NEW_ORACLE.toLowerCase());
  console.log("\nAfter:");
  console.log("  facetAddresses() count:", afterAddresses.length);
  console.log("  HedgeFacet in facetAddresses[]:  ", hedgeNow ? "✓" : "✗ STILL MISSING");
  console.log("  OracleFacet in facetAddresses[]: ", oracleNow ? "✓" : "✗ STILL MISSING");

  // Spot-check that selectors are still routed correctly
  const Hedge = await ethers.getContractAt("BlockFinaXHedgeFacet", DIAMOND);
  const signer = await Hedge.getPricingEngineSigner();
  console.log("  smoke: getPricingEngineSigner() =", signer);
}

main().catch(err => { console.error("Failed:", err); process.exitCode = 1; });
