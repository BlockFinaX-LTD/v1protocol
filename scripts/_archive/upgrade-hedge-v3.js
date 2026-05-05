/**
 * Upgrades the HedgeFacet to v3 — per-event payment token support.
 *
 * Changes vs v2 (upgrade-hedge-final.js):
 *   - createEvent() struct gains `address paymentToken` field (new selector)
 *   - All token transfers now use the event's stored paymentToken instead of s.usdcToken
 *   - 5 new functions: setAllowedPaymentToken, isAllowedPaymentToken,
 *     getEventPaymentToken, getPlatformFeesByToken, withdrawPlatformFeesByToken
 *
 * Strategy:
 *   Replace all selectors previously owned by the v2 HedgeFacet.
 *   Add the 5 brand-new selectors that don't exist yet in the Diamond.
 *
 * Required env vars:
 *   DIAMOND_ADDRESS — Diamond proxy address
 */

const hre = require("hardhat");
const { ethers } = hre;

// All selectors registered in the Diamond from the v2 HedgeFacet upgrade (upgrade-hedge-final.js).
// These are REPLACED (action 1) with the new v3 implementation.
// NOTE: createEvent (0x7e461a07) is included here because it still exists in the Diamond —
//       even though its ABI signature changed (new paymentToken field), the diamondCut Replace
//       will swap it out. The v3 selector will be Added separately via toAdd.
const TO_REPLACE = [
  // 25 from original undocumented HedgeFacet (replaced in v2, replaced again here)
  "0x6f2873f1", // buyProtection
  "0x8a69614e", // claimPayout
  "0xe00aafac", // claimPremiums
  "0x7e461a07", // createEvent (v2 selector — old struct)
  "0xe2bbb158", // deposit
  "0x7a400b48", // getCreatorEventIds
  "0x6435ec20", // getEventDepositIds
  "0x5a8ff039", // getEventPositionIds
  "0x54b994d9", // getHedgeEventCore
  "0x09864ee1", // getHedgeEventStats
  "0x6fae94dc", // getHedgeFeeConfig
  "0x034d4543", // getHedgeLpDeposit
  "0x6e958318", // getHedgePlatformFees
  "0x32b42381", // getHedgePosition
  "0x8ff6060b", // getHedgerPositionIds
  "0xfaada976", // getLpDepositIds
  "0xce43f1d7", // getPoolUtilization
  "0xe4cb2929", // getTotalHedgeEvents
  "0x1538fdc2", // initializeHedgeFees
  "0x7bc635cb", // setOracleAdmin
  "0x79f389c3", // setPoolSettings
  "0x169b405a", // settleEvent
  "0xd95b0a12", // withdrawCapital
  "0x95e6de4e", // withdrawCreatorEarnings
  "0x6aa21416", // withdrawPlatformFees
  // 6 added in upgrade-hedge-final.js (now Replaced)
  "0xdf7a01a6", // isFeesInitialized
  "0xb187bd26", // isPaused
  "0x8456cb59", // pause
  "0xd06be38e", // recoverExpiredPayouts
  "0x04824e70", // rescueETH
  "0x3f4ba83a", // unpause
];

async function main() {
  const [deployer] = await ethers.getSigners();
  const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
  if (!DIAMOND_ADDRESS) throw new Error("Set DIAMOND_ADDRESS env var");

  console.log("Deployer:", deployer.address);
  console.log("Diamond: ", DIAMOND_ADDRESS);

  // Deploy the new v3 HedgeFacet
  console.log("\nDeploying BlockFinaXHedgeFacet v3...");
  const HedgeFacet = await ethers.getContractFactory("BlockFinaXHedgeFacet");
  const hedgeFacet = await HedgeFacet.deploy();
  await hedgeFacet.waitForDeployment();
  const hedgeAddress = await hedgeFacet.getAddress();
  console.log("New HedgeFacet v3:", hedgeAddress);

  // Compute all selectors from the new facet's ABI
  const allSelectors = HedgeFacet.interface.fragments
    .filter(f => f.type === "function")
    .map(f => HedgeFacet.interface.getFunction(f.name).selector);

  console.log("\nAll v3 selectors from ABI:", allSelectors.length);

  // Query the Diamond to see which selectors already exist
  const DiamondLoupe = await ethers.getContractAt(
    ["function facetAddress(bytes4 selector) view returns (address)"],
    DIAMOND_ADDRESS
  );

  const toReplaceSelectors = [];
  const toAddSelectors = [];
  for (const sel of allSelectors) {
    const facet = await DiamondLoupe.facetAddress(sel);
    if (facet === ethers.ZeroAddress) {
      toAddSelectors.push(sel);
    } else {
      toReplaceSelectors.push(sel);
    }
  }

  console.log("Selectors to Replace (exist in Diamond):", toReplaceSelectors.length);
  console.log("Selectors to Add     (new to Diamond)  :", toAddSelectors.length);
  if (toAddSelectors.length > 0) {
    console.log("New selectors:", toAddSelectors);
  }

  // Sanity: make sure the hardcoded TO_REPLACE list matches what the Diamond says
  for (const sel of TO_REPLACE) {
    const facet = await DiamondLoupe.facetAddress(sel);
    if (facet === ethers.ZeroAddress) {
      console.warn(`  WARN: ${sel} from TO_REPLACE not found in Diamond — will skip it`);
    }
  }

  // Build diamondCut actions
  const cuts = [];
  if (toReplaceSelectors.length > 0) {
    cuts.push({ facetAddress: hedgeAddress, action: 1, functionSelectors: toReplaceSelectors });
  }
  if (toAddSelectors.length > 0) {
    cuts.push({ facetAddress: hedgeAddress, action: 0, functionSelectors: toAddSelectors });
  }

  console.log("\nExecuting diamondCut...");
  const DiamondCut = await ethers.getContractAt("BlockFinaXDiamondCutFacet", DIAMOND_ADDRESS);
  const tx = await DiamondCut.diamondCut(cuts, ethers.ZeroAddress, "0x");
  const receipt = await tx.wait();
  console.log("diamondCut tx:", receipt.hash);
  console.log("\nHedgeFacet v3 is live. Address:", hedgeAddress);
  console.log("\nNext steps:");
  console.log("  1. Run post-upgrade-v3.js to whitelist USDT once the mainnet address is confirmed.");
  console.log("  2. Verify the new facet on Blockscout.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
