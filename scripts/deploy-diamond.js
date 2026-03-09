const hre = require("hardhat");

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  console.log("Deploying BlockFinaX Diamond (Wallet + Hedge only)...\n");

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH\n");

  const USDC_ADDRESSES = {
    84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    4202: "0xf52Ad63619Bf9cFeF510341ac6b4038554399562",
    8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    1135: "0x",
  };
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  const USDC_ADDRESS = USDC_ADDRESSES[Number(chainId)];
  if (!USDC_ADDRESS || USDC_ADDRESS === "0x") {
    throw new Error(`No USDC address configured for chain ID ${chainId}`);
  }
  console.log("Chain ID:", Number(chainId));
  console.log("USDC Address:", USDC_ADDRESS);

  console.log("\nDeploying DiamondCutFacet...");
  const DiamondCutFacet = await hre.ethers.getContractFactory("BlockFinaXDiamondCutFacet");
  const diamondCutFacet = await DiamondCutFacet.deploy();
  await diamondCutFacet.waitForDeployment();
  const diamondCutAddress = await diamondCutFacet.getAddress();
  console.log("DiamondCutFacet:", diamondCutAddress);
  await wait(3000);

  console.log("\nDeploying Diamond...");
  const Diamond = await hre.ethers.getContractFactory("Diamond");
  const diamond = await Diamond.deploy(deployer.address, diamondCutAddress, USDC_ADDRESS);
  await diamond.waitForDeployment();
  const diamondAddress = await diamond.getAddress();
  console.log("Diamond:", diamondAddress);
  await wait(3000);

  console.log("\nDeploying DiamondLoupeFacet...");
  const DiamondLoupeFacet = await hre.ethers.getContractFactory("BlockFinaXDiamondLoupeFacet");
  const loupeFacet = await DiamondLoupeFacet.deploy();
  await loupeFacet.waitForDeployment();
  const loupeAddress = await loupeFacet.getAddress();
  console.log("DiamondLoupeFacet:", loupeAddress);
  await wait(3000);

  console.log("\nDeploying HedgeFacet...");
  const HedgeFacet = await hre.ethers.getContractFactory("BlockFinaXHedgeFacet");
  const hedgeFacet = await HedgeFacet.deploy();
  await hedgeFacet.waitForDeployment();
  const hedgeAddress = await hedgeFacet.getAddress();
  console.log("HedgeFacet:", hedgeAddress);
  await wait(3000);

  const loupeSelectors = [
    loupeFacet.interface.getFunction("facets").selector,
    loupeFacet.interface.getFunction("facetFunctionSelectors").selector,
    loupeFacet.interface.getFunction("facetAddresses").selector,
    loupeFacet.interface.getFunction("facetAddress").selector,
  ];

  const hedgeSelectors = [
    hedgeFacet.interface.getFunction("initializeHedgeFees").selector,
    hedgeFacet.interface.getFunction("setOracleAdmin").selector,
    hedgeFacet.interface.getFunction("withdrawPlatformFees").selector,
    hedgeFacet.interface.getFunction("createEvent").selector,
    hedgeFacet.interface.getFunction("setPoolSettings").selector,
    hedgeFacet.interface.getFunction("deposit").selector,
    hedgeFacet.interface.getFunction("buyProtection").selector,
    hedgeFacet.interface.getFunction("settleEvent").selector,
    hedgeFacet.interface.getFunction("claimPayout").selector,
    hedgeFacet.interface.getFunction("claimPremiums").selector,
    hedgeFacet.interface.getFunction("withdrawCapital").selector,
    hedgeFacet.interface.getFunction("withdrawCreatorEarnings").selector,
    hedgeFacet.interface.getFunction("getHedgeEventCore").selector,
    hedgeFacet.interface.getFunction("getHedgeEventStats").selector,
    hedgeFacet.interface.getFunction("getHedgePosition").selector,
    hedgeFacet.interface.getFunction("getHedgeLpDeposit").selector,
    hedgeFacet.interface.getFunction("getEventPositionIds").selector,
    hedgeFacet.interface.getFunction("getEventDepositIds").selector,
    hedgeFacet.interface.getFunction("getCreatorEventIds").selector,
    hedgeFacet.interface.getFunction("getHedgerPositionIds").selector,
    hedgeFacet.interface.getFunction("getLpDepositIds").selector,
    hedgeFacet.interface.getFunction("getHedgeFeeConfig").selector,
    hedgeFacet.interface.getFunction("getHedgePlatformFees").selector,
    hedgeFacet.interface.getFunction("getTotalHedgeEvents").selector,
    hedgeFacet.interface.getFunction("getPoolUtilization").selector,
  ];

  console.log("\nAdding facets to Diamond...");
  const facetCuts = [
    {
      facetAddress: loupeAddress,
      action: 0,
      functionSelectors: loupeSelectors
    },
    {
      facetAddress: hedgeAddress,
      action: 0,
      functionSelectors: hedgeSelectors
    }
  ];

  const diamondCut = await hre.ethers.getContractAt("BlockFinaXDiamondCutFacet", diamondAddress);
  const tx = await diamondCut.diamondCut(facetCuts, hre.ethers.ZeroAddress, "0x");
  await tx.wait();
  console.log("Facets added to Diamond");

  console.log("\nInitializing hedge fees...");
  const hedgeInterface = new hre.ethers.Interface([
    "function initializeHedgeFees(uint256,uint256,uint256,uint256,uint256)",
    "function setOracleAdmin(address)"
  ]);
  const initFeesTx = await deployer.sendTransaction({
    to: diamondAddress,
    data: hedgeInterface.encodeFunctionData("initializeHedgeFees", [
      25000000,
      5000,
      10000,
      10000,
      50000
    ])
  });
  await initFeesTx.wait();
  console.log("Hedge fees initialized (creation: $25, hedger: 0.5%, payout: 1%, LP: 1%, creator: 5%)");

  const setOracleTx = await deployer.sendTransaction({
    to: diamondAddress,
    data: hedgeInterface.encodeFunctionData("setOracleAdmin", [deployer.address])
  });
  await setOracleTx.wait();
  console.log("Oracle admin set to deployer:", deployer.address);

  console.log("\n" + "=".repeat(60));
  console.log("BLOCKFINAX DIAMOND DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.log("Network:", hre.network.name);
  console.log("Chain ID:", Number(chainId));
  console.log("\nDiamond:", diamondAddress);
  console.log("\nFacets (3 only — Wallet + Hedge product):");
  console.log("  DiamondCutFacet:", diamondCutAddress);
  console.log("  DiamondLoupeFacet:", loupeAddress);
  console.log("  HedgeFacet:", hedgeAddress);
  console.log("\nConfiguration:");
  console.log("  USDC Token:", USDC_ADDRESS);
  console.log("  Deployer/Oracle:", deployer.address);
  console.log("  Hedge Fees: $25 creation, 0.5% hedger, 1% payout, 1% LP, 5% creator");
  console.log("=".repeat(60));

  const fs = require("fs");
  const deploymentInfo = {
    standard: "EIP-2535 Diamond",
    network: hre.network.name,
    chainId: Number(chainId),
    diamond: diamondAddress,
    facets: {
      blockFinaXDiamondCut: diamondCutAddress,
      blockFinaXDiamondLoupe: loupeAddress,
      blockFinaXHedge: hedgeAddress
    },
    config: {
      usdcToken: USDC_ADDRESS,
      hedgeFees: {
        eventCreationFee: "25000000",
        hedgerFeeRate: "5000",
        hedgerPayoutFeeRate: "10000",
        lpProfitFeeRate: "10000",
        creatorLoyaltyRate: "50000"
      },
      oracleAdmin: deployer.address
    },
    deployer: deployer.address,
    timestamp: new Date().toISOString()
  };

  const filename = `deployments-diamond-${hre.network.name}.json`;
  fs.writeFileSync(filename, JSON.stringify(deploymentInfo, null, 2));
  console.log(`\nDeployment saved to ${filename}`);

  console.log("\nVerify contracts:");
  console.log(`npx hardhat verify --network ${hre.network.name} ${diamondCutAddress}`);
  console.log(`npx hardhat verify --network ${hre.network.name} ${diamondAddress} ${deployer.address} ${diamondCutAddress} ${USDC_ADDRESS}`);
  console.log(`npx hardhat verify --network ${hre.network.name} ${loupeAddress}`);
  console.log(`npx hardhat verify --network ${hre.network.name} ${hedgeAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
