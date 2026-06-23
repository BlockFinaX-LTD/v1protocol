const { ethers, network } = require("hardhat");
const fs = require("fs");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  const bal = await deployer.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(bal), "ETH\n");

  console.log("Deploying BlockFinaXOwnershipFacet...");
  const Factory = await ethers.getContractFactory("BlockFinaXOwnershipFacet");
  const facet   = await Factory.deploy();
  await facet.waitForDeployment();
  const addr = await facet.getAddress();
  console.log("OwnershipFacet deployed at:", addr);

  fs.mkdirSync("deployments", { recursive: true });
  const outFile = `deployments/deployments-ownership-facet-${network.name}.json`;
  fs.writeFileSync(
    outFile,
    JSON.stringify({ ownershipFacet: addr, deployedAt: new Date().toISOString() }, null, 2)
  );
  console.log("Saved to", outFile);
}

main().catch(e => { console.error(e.message); process.exit(1); });
