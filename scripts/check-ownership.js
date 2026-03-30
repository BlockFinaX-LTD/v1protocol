const { ethers } = require("hardhat");
const DIAMOND = "0x3eDfA00a1E3C158A591097de2FA1756aCD66860D";
async function main() {
  const hedge = await ethers.getContractAt("BlockFinaXHedgeFacet", DIAMOND);
  const pending = await hedge.pendingOwner();
  console.log("pendingOwner():", pending);
}
main().catch(e => { console.error(e.message); process.exit(1); });
