const { ethers } = require("hardhat");
const DIAMOND     = "0x3eDfA00a1E3C158A591097de2FA1756aCD66860D";
const NEW_OWNER   = "0xc69352C36562ce2D4C57B38baf47cE7D1eF6b891";
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("New owner:", NEW_OWNER);
  const hedge = await ethers.getContractAt("BlockFinaXHedgeFacet", DIAMOND);
  const tx = await hedge.transferOwnership(NEW_OWNER);
  await tx.wait();
  console.log("tx:", tx.hash);
  const pending = await hedge.pendingOwner();
  console.log("Pending owner confirmed:", pending);
}
main().catch(e => { console.error(e.message); process.exit(1); });
