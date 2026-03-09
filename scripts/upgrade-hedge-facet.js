const hre = require("hardhat");
const fs = require("fs");

async function main() {
  console.log("Upgrading BlockFinaXHedgeFacet...\n");

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH\n");

  const deploymentFile = `deployments-diamond-${hre.network.name}.json`;
  if (!fs.existsSync(deploymentFile)) {
    throw new Error(`Deployment file not found: ${deploymentFile}`);
  }
  const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  const DIAMOND_ADDRESS = deployment.diamond;
  const OLD_HEDGE_FACET = deployment.facets.blockFinaXHedge;

  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("Current HedgeFacet:", OLD_HEDGE_FACET);

  const LOUPE_ABI = [
    'function facetFunctionSelectors(address _facet) external view returns (bytes4[] memory facetFunctionSelectors_)',
  ];
  const loupe = await hre.ethers.getContractAt(LOUPE_ABI, DIAMOND_ADDRESS);
  const oldSelectorsRaw = await loupe.facetFunctionSelectors(OLD_HEDGE_FACET);
  const oldSelectors = Array.from(oldSelectorsRaw);
  console.log(`\nOld HedgeFacet has ${oldSelectors.length} selectors registered in Diamond`);

  console.log("\nDeploying new HedgeFacet...");
  const HedgeFacet = await hre.ethers.getContractFactory("BlockFinaXHedgeFacet");
  const newHedgeFacet = await HedgeFacet.deploy();
  await newHedgeFacet.waitForDeployment();
  const newHedgeAddress = await newHedgeFacet.getAddress();
  console.log("New HedgeFacet:", newHedgeAddress);

  const newSelectors = [
    newHedgeFacet.interface.getFunction("initializeHedgeFees").selector,
    newHedgeFacet.interface.getFunction("setOracleAdmin").selector,
    newHedgeFacet.interface.getFunction("withdrawPlatformFees").selector,
    newHedgeFacet.interface.getFunction("createEvent").selector,
    newHedgeFacet.interface.getFunction("setPoolSettings").selector,
    newHedgeFacet.interface.getFunction("deposit").selector,
    newHedgeFacet.interface.getFunction("buyProtection").selector,
    newHedgeFacet.interface.getFunction("settleEvent").selector,
    newHedgeFacet.interface.getFunction("claimPayout").selector,
    newHedgeFacet.interface.getFunction("claimPremiums").selector,
    newHedgeFacet.interface.getFunction("withdrawCapital").selector,
    newHedgeFacet.interface.getFunction("withdrawCreatorEarnings").selector,
    newHedgeFacet.interface.getFunction("getHedgeEventCore").selector,
    newHedgeFacet.interface.getFunction("getHedgeEventStats").selector,
    newHedgeFacet.interface.getFunction("getHedgePosition").selector,
    newHedgeFacet.interface.getFunction("getHedgeLpDeposit").selector,
    newHedgeFacet.interface.getFunction("getEventPositionIds").selector,
    newHedgeFacet.interface.getFunction("getEventDepositIds").selector,
    newHedgeFacet.interface.getFunction("getCreatorEventIds").selector,
    newHedgeFacet.interface.getFunction("getHedgerPositionIds").selector,
    newHedgeFacet.interface.getFunction("getLpDepositIds").selector,
    newHedgeFacet.interface.getFunction("getHedgeFeeConfig").selector,
    newHedgeFacet.interface.getFunction("getHedgePlatformFees").selector,
    newHedgeFacet.interface.getFunction("getTotalHedgeEvents").selector,
    newHedgeFacet.interface.getFunction("getPoolUtilization").selector,
  ];

  const newSelectorSet = new Set(newSelectors);
  const oldSelectorSet = new Set(oldSelectors.map(s => s.toLowerCase()));

  const toRemove = oldSelectors.filter(s => !newSelectorSet.has(s.toLowerCase()) && !newSelectorSet.has(s));
  const toAdd = newSelectors.filter(s => !oldSelectorSet.has(s.toLowerCase()));
  const toReplace = newSelectors.filter(s => oldSelectorSet.has(s.toLowerCase()));

  console.log(`\nSelectors to Remove: ${toRemove.length}`);
  console.log(`Selectors to Add:    ${toAdd.length}`);
  console.log(`Selectors to Replace: ${toReplace.length}`);

  const facetCuts = [];

  if (toAdd.length > 0) {
    facetCuts.push({ facetAddress: newHedgeAddress, action: 0, functionSelectors: toAdd });
  }
  if (toReplace.length > 0) {
    facetCuts.push({ facetAddress: newHedgeAddress, action: 1, functionSelectors: toReplace });
  }
  if (toRemove.length > 0) {
    facetCuts.push({ facetAddress: hre.ethers.ZeroAddress, action: 2, functionSelectors: toRemove });
  }

  console.log(`\nExecuting DiamondCut with ${facetCuts.length} cut(s)...`);

  const diamondCut = await hre.ethers.getContractAt("BlockFinaXDiamondCutFacet", DIAMOND_ADDRESS);
  const tx = await diamondCut.diamondCut(facetCuts, hre.ethers.ZeroAddress, "0x");
  console.log("DiamondCut tx:", tx.hash);
  await tx.wait();
  console.log("Upgrade complete!");

  console.log("\n" + "=".repeat(50));
  console.log("HEDGE FACET UPGRADE SUMMARY");
  console.log("=".repeat(50));
  console.log("Old HedgeFacet:", OLD_HEDGE_FACET);
  console.log("New HedgeFacet:", newHedgeAddress);
  console.log("Diamond:", DIAMOND_ADDRESS);
  console.log("=".repeat(50));

  deployment.facets.blockFinaXHedge = newHedgeAddress;
  deployment.upgrades = deployment.upgrades || [];
  deployment.upgrades.push({
    facet: "blockFinaXHedge",
    oldAddress: OLD_HEDGE_FACET,
    newAddress: newHedgeAddress,
    change: "Bidirectional hedging: strikeAbove bool — support both upward and downward hedge directions",
    timestamp: new Date().toISOString()
  });
  fs.writeFileSync(deploymentFile, JSON.stringify(deployment, null, 2));
  console.log(`\nDeployment file updated: ${deploymentFile}`);

  console.log("\nVerify:");
  console.log(`npx hardhat verify --network ${hre.network.name} ${newHedgeAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Upgrade failed:", error);
    process.exit(1);
  });
