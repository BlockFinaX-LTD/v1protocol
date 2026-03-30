const { ethers } = require("hardhat");
const fs = require("fs");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const bal = await deployer.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(bal), "ETH\n");

  console.log("1. Deploying TimelockCutFacet v2...");
  const TF = await ethers.getContractFactory("BlockFinaXTimelockCutFacet");
  const tf = await TF.deploy();
  await tf.waitForDeployment();
  const tfAddr = await tf.getAddress();
  console.log("   TimelockCutFacet v2:", tfAddr);

  console.log("2. Deploying HedgeFacet v7...");
  const HF = await ethers.getContractFactory("BlockFinaXHedgeFacet");
  const hf = await HF.deploy();
  await hf.waitForDeployment();
  const hfAddr = await hf.getAddress();
  console.log("   HedgeFacet v7:", hfAddr);

  const result = {
    timelockCutFacetV2: tfAddr,
    hedgeFacetV7: hfAddr,
    deployedAt: new Date().toISOString(),
    changes: [
      "TimelockCutFacet: added MAX_PROPOSAL_AGE (30d expiry), added getAllCutIds()",
      "HedgeFacet: removed onlyOwner from recoverExpiredPayouts"
    ]
  };
  fs.writeFileSync("deployments-v2fixes-liskMainnet.json", JSON.stringify(result, null, 2));
  console.log("\nSaved to deployments-v2fixes-liskMainnet.json");
}

main().catch(e => { console.error(e.message); process.exit(1); });
