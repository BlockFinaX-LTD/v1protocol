/**
 * Post-upgrade v3: whitelist allowed payment tokens.
 * Run after upgrade-hedge-v3.js succeeds.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... npx hardhat run scripts/post-upgrade-v3.js --network liskSepolia
 */

const hre = require("hardhat");
const { ethers } = hre;

const USDC_LISK_SEPOLIA = "0xf52Ad63619Bf9cFeF510341ac6b4038554399562";

async function main() {
  const [deployer] = await ethers.getSigners();
  const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
  if (!DIAMOND_ADDRESS) throw new Error("Set DIAMOND_ADDRESS env var");

  console.log("Deployer:", deployer.address);
  console.log("Diamond: ", DIAMOND_ADDRESS);

  const hedge = await ethers.getContractAt(
    ["function setAllowedPaymentToken(address token, bool allowed) external",
     "function isAllowedPaymentToken(address token) view returns (bool)"],
    DIAMOND_ADDRESS
  );

  // Whitelist USDC
  const alreadyAllowed = await hedge.isAllowedPaymentToken(USDC_LISK_SEPOLIA);
  if (alreadyAllowed) {
    console.log("USDC already whitelisted — nothing to do.");
  } else {
    console.log("Whitelisting USDC...");
    const tx = await hedge.setAllowedPaymentToken(USDC_LISK_SEPOLIA, true);
    await tx.wait();
    console.log("USDC whitelisted. tx:", tx.hash);
  }

  const confirmed = await hedge.isAllowedPaymentToken(USDC_LISK_SEPOLIA);
  console.log("\nUSdc allowed:", confirmed);
  console.log("Done. USDT can be whitelisted once the mainnet address is confirmed from bridge.lisk.com.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
