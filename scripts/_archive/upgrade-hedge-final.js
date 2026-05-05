/**
 * Upgrades the HedgeFacet in the Diamond:
 *   - Replaces 25 existing selectors (previously owned by the original undocumented HedgeFacet)
 *   - Adds 6 new selectors (security hardening: pause, rescueETH, recoverExpiredPayouts, etc.)
 *
 * Required env vars:
 *   DIAMOND_ADDRESS — Diamond proxy address
 */

const hre = require("hardhat");

// Selectors currently registered to the original HedgeFacet (0x1B2aca3f...)
// These need action 1 (Replace), not Add
const TO_REPLACE = [
  "0x6f2873f1", // buyProtection
  "0x8a69614e", // claimPayout
  "0xe00aafac", // claimPremiums
  "0x7e461a07", // createEvent
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
];

// New selectors not in any existing facet — action 0 (Add)
const TO_ADD = [
  "0xdf7a01a6", // isFeesInitialized
  "0xb187bd26", // isPaused
  "0x8456cb59", // pause
  "0xd06be38e", // recoverExpiredPayouts
  "0x04824e70", // rescueETH
  "0x3f4ba83a", // unpause
];

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
  if (!DIAMOND_ADDRESS) throw new Error("Set DIAMOND_ADDRESS env var");

  console.log("Deployer:", deployer.address);
  console.log("Diamond: ", DIAMOND_ADDRESS);

  console.log("\nDeploying new HedgeFacet...");
  const HedgeFacet = await hre.ethers.getContractFactory("BlockFinaXHedgeFacet");
  const hedgeFacet = await HedgeFacet.deploy();
  await hedgeFacet.waitForDeployment();
  const hedgeAddress = await hedgeFacet.getAddress();
  console.log("New HedgeFacet:", hedgeAddress);
  console.log("Selectors to Replace:", TO_REPLACE.length);
  console.log("Selectors to Add:   ", TO_ADD.length);

  const DiamondCut = await hre.ethers.getContractAt("BlockFinaXDiamondCutFacet", DIAMOND_ADDRESS);
  const tx = await DiamondCut.diamondCut(
    [
      { facetAddress: hedgeAddress, action: 1, functionSelectors: TO_REPLACE },
      { facetAddress: hedgeAddress, action: 0, functionSelectors: TO_ADD },
    ],
    hre.ethers.ZeroAddress,
    "0x"
  );
  const receipt = await tx.wait();
  console.log("\ndiamondCut tx:", receipt.hash);
  console.log("HedgeFacet fully live. Address:", hedgeAddress);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
