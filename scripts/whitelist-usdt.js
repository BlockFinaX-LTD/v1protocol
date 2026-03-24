const { ethers } = require("hardhat");

async function main() {
  const DIAMOND = process.env.DIAMOND_ADDRESS;
  const USDT = process.env.USDT_ADDRESS;
  if (!DIAMOND || !USDT) throw new Error("Set DIAMOND_ADDRESS and USDT_ADDRESS");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("USDT:    ", USDT);

  const hedge = await ethers.getContractAt([
    "function setAllowedPaymentToken(address token, bool allowed) external",
    "function isAllowedPaymentToken(address token) view returns (bool)"
  ], DIAMOND);

  const already = await hedge.isAllowedPaymentToken(USDT);
  if (already) {
    console.log("USDT already whitelisted.");
    return;
  }

  const tx = await hedge.setAllowedPaymentToken(USDT, true);
  await tx.wait();
  console.log("Done. tx:", tx.hash);
  console.log("Confirmed:", await hedge.isAllowedPaymentToken(USDT));
}

main().catch(e => { console.error(e); process.exitCode = 1; });
