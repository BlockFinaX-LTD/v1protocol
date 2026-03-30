/**
 * resume-mainnet-cut.js
 *
 * Picks up the BlockFinaX mainnet deployment after the 5 contracts were deployed
 * but the diamondCut + init steps failed.
 *
 * Already deployed on Lisk mainnet (chain 1135):
 *   DiamondCutFacet: 0x3581E16414286AD77601f9489F26a11eD96A9Be4
 *   Diamond:         0x3eDfA00a1E3C158A591097de2FA1756aCD66860D
 *   LoupeFacet:      0xcC594031d1c059Eb1d6bCb0c7b1c82D31115E6E6
 *   HedgeFacet:      0xCd84f1493497Dbaf5C1933907bD2D253a54233Bf
 *   OracleFacet:     0xA7af536A57eA2c20a3a3ae6B70b6943c78226f73
 */

const hre = require("hardhat");
const { ethers } = hre;

const DIAMOND     = "0x3eDfA00a1E3C158A591097de2FA1756aCD66860D";
const CUT_FACET   = "0x3581E16414286AD77601f9489F26a11eD96A9Be4";
const LOUPE       = "0xcC594031d1c059Eb1d6bCb0c7b1c82D31115E6E6";
const HEDGE       = "0xCd84f1493497Dbaf5C1933907bD2D253a54233Bf";
const ORACLE      = "0xA7af536A57eA2c20a3a3ae6B70b6943c78226f73";

const wait = (ms) => new Promise(r => setTimeout(r, ms));

function getSelectors(contract) {
  return contract.interface.fragments
    .filter(f => f.type === "function")
    .map(f => contract.interface.getFunction(f.name).selector);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("\n=== BlockFinaX Mainnet Resume ===");
  console.log("Deployer:", deployer.address);
  console.log("Balance: ", ethers.formatEther(bal), "ETH\n");

  // Attach to already-deployed facets to get their ABIs / selectors
  const loupeFacet  = await ethers.getContractAt("BlockFinaXDiamondLoupeFacet", LOUPE);
  const hedgeFacet  = await ethers.getContractAt("BlockFinaXHedgeFacet", HEDGE);
  const oracleFacet = await ethers.getContractAt("BlockFinaXOracleFacet", ORACLE);

  const loupeSelectors  = getSelectors(loupeFacet);
  const hedgeSelectors  = getSelectors(hedgeFacet);
  const oracleSelectors = getSelectors(oracleFacet);

  console.log(`Selectors — Loupe: ${loupeSelectors.length}, Hedge: ${hedgeSelectors.length}, Oracle: ${oracleSelectors.length}`);

  // ── Step 1: diamondCut ──────────────────────────────────────────────────────
  console.log("\nStep 1: wiring all facets into the Diamond...");
  const diamondCut = await ethers.getContractAt("BlockFinaXDiamondCutFacet", DIAMOND);

  const facetCuts = [
    { facetAddress: LOUPE,  action: 0, functionSelectors: loupeSelectors  },
    { facetAddress: HEDGE,  action: 0, functionSelectors: hedgeSelectors  },
    { facetAddress: ORACLE, action: 0, functionSelectors: oracleSelectors },
  ];

  const cutTx = await diamondCut.diamondCut(facetCuts, ethers.ZeroAddress, "0x");
  await cutTx.wait();
  console.log("  diamondCut tx:", cutTx.hash);
  await wait(3000);

  // ── Step 2: initializeHedgeFees ─────────────────────────────────────────────
  console.log("\nStep 2: initialising fee config...");
  const hedge = await ethers.getContractAt("BlockFinaXHedgeFacet", DIAMOND);
  const initTx = await hedge.initializeHedgeFees(
    25_000_000,   // creationFee    = $25 USDC (6 decimals)
    5_000,        // hedgerFeeRate  = 0.5%
    10_000,       // hedgerPayoutFeeRate = 1.0%
    10_000,       // lpProfitFeeRate     = 1.0%
    50_000        // creatorLoyaltyRate  = 5.0%
  );
  await initTx.wait();
  console.log("  Fees initialised. tx:", initTx.hash);
  await wait(3000);

  // ── Step 3: setOracleAdmin ──────────────────────────────────────────────────
  console.log("\nStep 3: setting oracle admin (temporary — rotate to dedicated key post-launch)...");
  const adminTx = await hedge.setOracleAdmin(deployer.address);
  await adminTx.wait();
  console.log("  Oracle admin set to deployer:", deployer.address);

  // ── Summary ─────────────────────────────────────────────────────────────────
  const finalBal = await ethers.provider.getBalance(deployer.address);
  console.log("\n" + "=".repeat(55));
  console.log(" DEPLOYMENT COMPLETE");
  console.log("=".repeat(55));
  console.log("Diamond (proxy):     ", DIAMOND);
  console.log("DiamondCutFacet:     ", CUT_FACET);
  console.log("DiamondLoupeFacet:   ", LOUPE);
  console.log("HedgeFacet:          ", HEDGE);
  console.log("OracleFacet:         ", ORACLE);
  console.log("Remaining balance:   ", ethers.formatEther(finalBal), "ETH");
  console.log("=".repeat(55));
  console.log("\nPOST-DEPLOY CHECKLIST:");
  console.log("  [ ] 1. Register oracle wallets: addOracle(A), addOracle(B), setRequiredSigners(2)");
  console.log("  [ ] 2. transferOwnership() → Gnosis Safe, then Safe calls acceptOwnership()");
  console.log("  [ ] 3. Update frontend DIAMOND_ADDRESS to", DIAMOND);
  console.log("  [ ] 4. Verify contracts on Blockscout");
  console.log("  [ ] 5. After oracle nodes confirmed live: call activateOracleV2()");
}

main().catch(e => { console.error("Resume failed:", e.message); process.exit(1); });
