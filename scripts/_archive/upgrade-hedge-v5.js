/**
 * Upgrades the HedgeFacet to v5 — the final pre-mainnet audit fixes.
 *
 * Changes vs v4 (current on Lisk Sepolia):
 *   Fix 1 — Fee snapshot: rates are captured at createEvent() and used for the entire event
 *            lifetime. Changes to the global fee config cannot retroactively affect active events.
 *   Fix 2 — External LP poolOpen: deposit() now requires poolOpen=true for non-creator LPs,
 *            so a creator who explicitly closes the pool is respected.
 *   Fix 3 — settleEvent guard: prevents settling an event with no hedger positions unless it
 *            has already passed expiry. Stops oracle front-running on empty pools.
 *   Fix 4 — MasterChef premium accumulator: _distributePremiumToLps() is now O(1) regardless
 *            of LP count (replaces the O(n ≤ 200) push loop). LPs pull lazily at claimPremiums.
 *
 * Storage layout changes (all appended at end of structs — Diamond layout safe):
 *   HedgeEvent    : + snapshotHedgerFeeRate, snapshotPayoutFeeRate, snapshotLpProfitFeeRate,
 *                     snapshotCreatorLoyaltyRate, feeSnapshotSet (bool),
 *                     accPremiumPerShare, totalActiveShares
 *   HedgeLpDeposit: + rewardDebt
 *
 * New public function:
 *   pendingPremiums(uint256 depositId) → uint256   (view — gross USDC pending before fees)
 *
 * Required env vars:
 *   DIAMOND_ADDRESS — Diamond proxy address (Lisk Sepolia or Mainnet)
 */

const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const [deployer] = await ethers.getSigners();
  const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
  if (!DIAMOND_ADDRESS) throw new Error("Set DIAMOND_ADDRESS env var");

  console.log("=== HedgeFacet v5 Upgrade ===");
  console.log("Deployer:", deployer.address);
  console.log("Diamond: ", DIAMOND_ADDRESS);
  console.log("Network: ", hre.network.name);

  // 1. Deploy the new HedgeFacet v5
  console.log("\nDeploying BlockFinaXHedgeFacet v5...");
  const HedgeFacet = await ethers.getContractFactory("BlockFinaXHedgeFacet");
  const hedgeFacet = await HedgeFacet.deploy();
  await hedgeFacet.waitForDeployment();
  const hedgeAddress = await hedgeFacet.getAddress();
  console.log("New HedgeFacet v5:", hedgeAddress);

  // 2. Collect all selectors exposed by the new facet
  const allSelectors = HedgeFacet.interface.fragments
    .filter(f => f.type === "function")
    .map(f => HedgeFacet.interface.getFunction(f.name).selector);

  console.log("\nTotal v5 selectors:", allSelectors.length);

  // 3. Query the Diamond Loupe to split selectors into Replace vs Add
  const DiamondLoupe = await ethers.getContractAt(
    ["function facetAddress(bytes4 selector) view returns (address)"],
    DIAMOND_ADDRESS
  );

  const toReplaceSelectors = [];
  const toAddSelectors = [];

  for (const sel of allSelectors) {
    const existingFacet = await DiamondLoupe.facetAddress(sel);
    if (existingFacet === ethers.ZeroAddress) {
      toAddSelectors.push(sel);
    } else {
      toReplaceSelectors.push(sel);
    }
  }

  console.log("Selectors to Replace (exist in Diamond):", toReplaceSelectors.length);
  console.log("Selectors to Add     (new to Diamond)  :", toAddSelectors.length);

  if (toAddSelectors.length > 0) {
    console.log("New selectors being added:");
    for (const sel of toAddSelectors) {
      const frag = HedgeFacet.interface.fragments.find(
        f => f.type === "function" && HedgeFacet.interface.getFunction(f.name).selector === sel
      );
      console.log(`  ${sel}  ${frag ? frag.name : "unknown"}`);
    }
  }

  // 4. Build diamondCut actions
  const cuts = [];
  if (toReplaceSelectors.length > 0) {
    cuts.push({ facetAddress: hedgeAddress, action: 1, functionSelectors: toReplaceSelectors }); // Replace
  }
  if (toAddSelectors.length > 0) {
    cuts.push({ facetAddress: hedgeAddress, action: 0, functionSelectors: toAddSelectors }); // Add
  }

  if (cuts.length === 0) {
    console.error("\nNo selectors to upgrade — aborting.");
    process.exitCode = 1;
    return;
  }

  // 5. Execute the diamondCut
  console.log("\nExecuting diamondCut...");
  const DiamondCut = await ethers.getContractAt("BlockFinaXDiamondCutFacet", DIAMOND_ADDRESS);
  const tx = await DiamondCut.diamondCut(cuts, ethers.ZeroAddress, "0x");
  const receipt = await tx.wait();
  console.log("diamondCut tx:", receipt.hash);

  // 6. Quick smoke test — call a view function through the Diamond
  const HedgeViaDiamond = await ethers.getContractAt("BlockFinaXHedgeFacet", DIAMOND_ADDRESS);
  try {
    const fees = await HedgeViaDiamond.getHedgeFeeConfig();
    console.log("\nSmoke test — getHedgeFeeConfig():", fees);
  } catch (e) {
    console.warn("Smoke test failed:", e.message);
  }

  console.log("\n=== HedgeFacet v5 is live ===");
  console.log("New facet address:", hedgeAddress);
  console.log("\nNext steps:");
  console.log("  1. Verify on Blockscout:");
  console.log(`     npx hardhat verify --network ${hre.network.name} ${hedgeAddress}`);
  console.log("  2. Run a full integration test on Sepolia before mainnet.");
  console.log("  3. Re-run this script with DIAMOND_ADDRESS=<mainnet proxy> on liskMainnet.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
