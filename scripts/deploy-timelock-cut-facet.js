const { ethers } = require("hardhat");
const fs = require("fs");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await deployer.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  console.log("\nDeploying BlockFinaXTimelockCutFacet...");
  const Factory = await ethers.getContractFactory("BlockFinaXTimelockCutFacet");
  const facet = await Factory.deploy();
  await facet.waitForDeployment();
  const addr = await facet.getAddress();
  console.log("TimelockCutFacet deployed at:", addr);

  const result = { timelockCutFacet: addr, deployedAt: new Date().toISOString() };
  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync(
    "deployments/deployments-timelock-cut-liskMainnet.json",
    JSON.stringify(result, null, 2)
  );
  console.log("\nSaved to deployments/deployments-timelock-cut-liskMainnet.json");
  console.log("\nNext step: install this facet on the Diamond via the /install-timelock page.");
}

main().catch(e => { console.error(e.message); process.exit(1); });
