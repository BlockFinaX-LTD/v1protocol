/**
 * upgrade-rescue-erc20.js
 * Upgrades the HedgeFacet on all deployed Diamonds to add rescueERC20().
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-rescue-erc20.js --network lisk
 *   npx hardhat run scripts/upgrade-rescue-erc20.js --network base
 *   npx hardhat run scripts/upgrade-rescue-erc20.js --network bsc
 */
const hre = require("hardhat");
const fs  = require("fs");

const DIAMOND_ADDRESSES = {
  1135: "0x69cB5BA093e44B345B617f72a148Ee43c4a18465",
  8453: "0xbCC51E62C4948FD35ab505bd71804C849601e4Ef",
  56:   "0xaC939C0897981Abc0711ec4e37527F13106180fc",
};

const DIAMOND_CUT_ABI = [
  "function diamondCut((address facetAddress, uint8 action, bytes4[] functionSelectors)[] _diamondCut, address _init, bytes _calldata) external",
];

const ADD_ACTION = 0; // FacetCutAction.Add

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network    = await hre.ethers.provider.getNetwork();
  const chainId    = Number(network.chainId);

  // Always use the hardcoded new addresses — env vars may point to old contracts.
  const diamondAddress = DIAMOND_ADDRESSES[chainId];
  if (!diamondAddress) throw new Error(`No diamond address for chain ${chainId}`);

  console.log(`\nUpgrading Diamond on ${hre.network.name} (${chainId})`);
  console.log(`Diamond:  ${diamondAddress}`);
  console.log(`Deployer: ${deployer.address}`);

  // 1. Deploy new HedgeFacet
  console.log("\nDeploying new HedgeFacet...");
  const HedgeFacet    = await hre.ethers.getContractFactory("BlockFinaXHedgeFacet");
  const newHedgeFacet = await HedgeFacet.deploy();
  await newHedgeFacet.waitForDeployment();
  const newHedgeAddress = await newHedgeFacet.getAddress();
  console.log(`New HedgeFacet: ${newHedgeAddress}`);

  // 2. Compute the selector for rescueERC20(address,address)
  const iface = newHedgeFacet.interface;
  const selector = iface.getFunction("rescueERC20").selector;
  console.log(`rescueERC20 selector: ${selector}`);

  // 3. DiamondCut — ADD only the new selector
  const diamond = new hre.ethers.Contract(diamondAddress, DIAMOND_CUT_ABI, deployer);
  const cut = [
    {
      facetAddress: newHedgeAddress,
      action: ADD_ACTION,
      functionSelectors: [selector],
    },
  ];

  console.log("\nSubmitting diamondCut (ADD rescueERC20)...");
  const tx = await diamond.diamondCut(cut, hre.ethers.ZeroAddress, "0x");
  await tx.wait();
  console.log(`diamondCut tx: ${tx.hash}`);

  // 4. Save record
  const record = {
    network: hre.network.name,
    chainId,
    diamond: diamondAddress,
    newHedgeFacet: newHedgeAddress,
    addedSelectors: [selector],
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
  };
  const outFile = `upgrades-rescue-erc20-${hre.network.name}.json`;
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
  console.log(`\nUpgrade saved to ${outFile}`);

  console.log("\nVERIFICATION COMMAND:");
  console.log(`  npx hardhat verify --network ${hre.network.name} ${newHedgeAddress}`);
}

main().catch(e => { console.error("Upgrade failed:", e.message); process.exit(1); });
