const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const DIAMOND = "0x885E663645173a0791b82f0e6608921D31E3D700";
  const hedge = await hre.ethers.getContractAt("BlockFinaXHedgeFacet", DIAMOND, deployer);

  const tx = await hedge.initializeHedgeFees(
    2_000_000,   // eventCreationFee = $2.00 USDC (6 decimals)
    5_000,       // hedgerFeeRate    = 0.5%
    10_000,      // hedgerPayoutFeeRate = 1.0%
    10_000,      // lpProfitFeeRate  = 1.0%
    50_000       // creatorLoyaltyRate = 5.0%
  );
  console.log("tx:", tx.hash);
  await tx.wait();

  const config = await hedge.getHedgeFeeConfig();
  console.log("eventCreationFee:", Number(config.eventCreationFee)/1e6, "USDC ✓");
}

main().catch(e => { console.error(e.message); process.exit(1); });
