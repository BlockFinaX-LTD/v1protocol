const { ethers } = require("hardhat");
async function main() {
  const bal = await ethers.provider.getBalance("0xef5Bed7c221c85A2c88e3c0223ee45482d6F037d");
  console.log("Deployer balance:", ethers.formatEther(bal), "ETH");
}
main().catch(e => { console.error(e); process.exit(1); });
