/**
 * set-creation-fee.js
 * Updates the event creation fee on the deployed Diamond contract.
 *
 * All other fee parameters are read live from the contract and preserved unchanged.
 *
 * Usage (from the contracts/ directory):
 *   DEPLOYER_PRIVATE_KEY=0x... DIAMOND_ADDRESS=0x3582D8f5f88ef557ce10Af26834FAC8B8e1445bf \
 *     npx hardhat run scripts/set-creation-fee.js --network baseSepolia
 */

const hre = require("hardhat");
const { ethers } = hre;

const DIAMOND_ADDRESS =
  process.env.DIAMOND_ADDRESS ||
  "0x3582D8f5f88ef557ce10Af26834FAC8B8e1445bf";

// New creation fee: $5.00 (6-decimal USDC/USDT format)
const NEW_CREATION_FEE = ethers.parseUnits("5", 6); // 5_000_000

const FEE_ABI = [
  "function getHedgeFeeConfig() view returns (uint256, uint256, uint256, uint256, uint256)",
  "function initializeHedgeFees(uint256,uint256,uint256,uint256,uint256) external",
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer :", deployer.address);
  console.log("Diamond  :", DIAMOND_ADDRESS);
  console.log("New fee  : $5.00\n");

  const hedge = await ethers.getContractAt(FEE_ABI, DIAMOND_ADDRESS);

  // Read current fee config from the chain
  const fees = await hedge.getHedgeFeeConfig();
  const [currentCreationFee, hedgerFeeRate, hedgerPayoutFeeRate, lpProfitFeeRate, creatorLoyaltyRate] = fees;

  console.log("Current fee config:");
  console.log("  Creation fee      :", ethers.formatUnits(currentCreationFee, 6), "USDC");
  console.log("  Hedger fee rate   :", (Number(hedgerFeeRate) / 1e6 * 100).toFixed(2) + "%");
  console.log("  Payout fee rate   :", (Number(hedgerPayoutFeeRate) / 1e6 * 100).toFixed(2) + "%");
  console.log("  LP profit fee rate:", (Number(lpProfitFeeRate) / 1e6 * 100).toFixed(2) + "%");
  console.log("  Creator loyalty   :", (Number(creatorLoyaltyRate) / 1e6 * 100).toFixed(2) + "%");

  console.log("\nUpdating creation fee to $5.00 — all other fees unchanged...");

  const tx = await hedge.initializeHedgeFees(
    NEW_CREATION_FEE,      // $5 creation fee  ← changed
    hedgerFeeRate,         // unchanged
    hedgerPayoutFeeRate,   // unchanged
    lpProfitFeeRate,       // unchanged
    creatorLoyaltyRate     // unchanged
  );

  console.log("Tx submitted:", tx.hash);
  await tx.wait();
  console.log("Confirmed!\n");

  // Verify
  const updated = await hedge.getHedgeFeeConfig();
  console.log("New creation fee on-chain:", ethers.formatUnits(updated[0], 6), "USDC ✓");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
