/**
 * deploy-diamond.js — Full fresh deployment of the BlockFinaX Diamond system
 *
 * Deploys everything from scratch:
 *   1. BlockFinaXDiamondCutFacet
 *   2. Diamond (proxy)
 *   3. BlockFinaXDiamondLoupeFacet
 *   4. BlockFinaXHedgeFacet  (security-hardened build — 34 selectors)
 *   5. BlockFinaXOracleFacet (multi-signer oracle — all selectors via reflection)
 *
 * Then initialises in one go:
 *   - initializeHedgeFees()
 *   - setOracleAdmin(deployer)      ← rotate to a dedicated key post-deploy
 *   - addOracle(ORACLE_A/B/C)       ← if ORACLE_A/B/C env vars are set
 *   - setRequiredSigners(2)         ← if ≥2 oracle addresses provided
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY   — wallet that funds gas and owns the Diamond initially
 *
 * Optional env vars:
 *   ORACLE_A / ORACLE_B / ORACLE_C  — oracle node wallet addresses (no private keys here)
 *   USDC_LISK_MAINNET               — override USDC address for Lisk Mainnet (chainId 1135)
 *                                     Verify at https://blockscout.lisk.com before deploying
 *
 * Usage:
 *   npx hardhat run scripts/deploy-diamond.js --network liskSepolia
 *   npx hardhat run scripts/deploy-diamond.js --network lisk
 */

const hre = require("hardhat");
const fs = require("fs");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Return every function selector exposed by a contract (excluding init(bytes)). */
function getSelectors(contract) {
  return contract.interface.fragments
    .filter(f => f.type === "function")
    .map(f => contract.interface.getFunction(f.name).selector);
}

/** Payment token per chain (USDC on Lisk/Base, USDT on BSC). */
const PAYMENT_TOKEN_ADDRESSES = {
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia USDC
  4202:  "0xf52Ad63619Bf9cFeF510341ac6b4038554399562", // Lisk Sepolia USDC
  8453:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base Mainnet USDC
  1135:  "0xF242275d3a6527d877f2c927a82D9b057609cc71", // Lisk Mainnet USDC
  56:    "0x55d398326f99059fF775485246999027B3197955", // BSC Mainnet USDT (18 dec)
  97:    "0x337610d27c682E347C9cD60BD4b3b107C9d34aeB", // BSC Testnet USDT
};

/**
 * Per-chain fee initialisation parameters for initializeHedgeFees().
 * eventCreationFee is in the payment token's native decimals.
 * Rate fields use PRECISION = 1e6 as denominator (e.g. 5000 = 0.5%).
 */
const CHAIN_FEES = {
  // Default — USDC chains (6 decimals): $25 creation fee
  default: {
    eventCreationFee:    25_000_000n,    // $25.00 in 6-dec USDC
    hedgerFeeRate:        5_000n,        // 0.5%
    hedgerPayoutFeeRate: 10_000n,        // 1.0%
    lpProfitFeeRate:     10_000n,        // 1.0%
    creatorLoyaltyRate:  50_000n,        // 5.0%
  },
  // BSC — USDT (18 decimals): $2 creation fee (lower barrier for BSC market)
  56: {
    eventCreationFee:    2_000_000_000_000_000_000n, // $2.00 in 18-dec USDT
    hedgerFeeRate:        5_000n,
    hedgerPayoutFeeRate: 10_000n,
    lpProfitFeeRate:     10_000n,
    creatorLoyaltyRate:  50_000n,
  },
  97: {
    eventCreationFee:    2_000_000_000_000_000_000n,
    hedgerFeeRate:        5_000n,
    hedgerPayoutFeeRate: 10_000n,
    lpProfitFeeRate:     10_000n,
    creatorLoyaltyRate:  50_000n,
  },
};

async function main() {
  console.log("\n" + "=".repeat(60));
  console.log(" BlockFinaX Diamond — FRESH DEPLOYMENT");
  console.log("=".repeat(60) + "\n");

  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  console.log("Network:         ", hre.network.name);
  console.log("Chain ID:        ", chainId);
  console.log("Deployer:        ", deployer.address);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:         ", hre.ethers.formatEther(balance), "ETH\n");

  if (balance === 0n) {
    throw new Error("Deployer balance is zero — fund the wallet before deploying.");
  }

  const USDC_ADDRESS = PAYMENT_TOKEN_ADDRESSES[chainId];
  if (!USDC_ADDRESS) {
    throw new Error(
      `No payment token address configured for chain ID ${chainId}.\n` +
      `Add it to the PAYMENT_TOKEN_ADDRESSES map in deploy-diamond.js.`
    );
  }
  const fees = CHAIN_FEES[chainId] || CHAIN_FEES.default;
  const tokenSymbol = chainId === 56 || chainId === 97 ? "USDT" : "USDC";
  console.log(`${tokenSymbol}:            `, USDC_ADDRESS, "\n");

  // ────────────────────────────────────────────────────────────────────────────
  // 1. DiamondCutFacet
  // ────────────────────────────────────────────────────────────────────────────
  console.log("Deploying DiamondCutFacet...");
  const DiamondCutFacet = await hre.ethers.getContractFactory("BlockFinaXDiamondCutFacet");
  const diamondCutFacet = await DiamondCutFacet.deploy();
  await diamondCutFacet.waitForDeployment();
  const diamondCutAddress = await diamondCutFacet.getAddress();
  console.log("  DiamondCutFacet:", diamondCutAddress);
  await wait(3000);

  // ────────────────────────────────────────────────────────────────────────────
  // 2. Diamond proxy
  // ────────────────────────────────────────────────────────────────────────────
  console.log("Deploying Diamond...");
  const Diamond = await hre.ethers.getContractFactory("BlockFinaXDiamond");
  const diamond = await Diamond.deploy(deployer.address, diamondCutAddress, USDC_ADDRESS);
  await diamond.waitForDeployment();
  const diamondAddress = await diamond.getAddress();
  console.log("  Diamond:        ", diamondAddress);
  await wait(3000);

  // ────────────────────────────────────────────────────────────────────────────
  // 3. DiamondLoupeFacet
  // ────────────────────────────────────────────────────────────────────────────
  console.log("Deploying DiamondLoupeFacet...");
  const DiamondLoupeFacet = await hre.ethers.getContractFactory("BlockFinaXDiamondLoupeFacet");
  const loupeFacet = await DiamondLoupeFacet.deploy();
  await loupeFacet.waitForDeployment();
  const loupeAddress = await loupeFacet.getAddress();
  console.log("  LoupeFacet:     ", loupeAddress);
  await wait(3000);

  // ────────────────────────────────────────────────────────────────────────────
  // 4. HedgeFacet (security-hardened, 34 selectors)
  // ────────────────────────────────────────────────────────────────────────────
  console.log("Deploying HedgeFacet...");
  const HedgeFacet = await hre.ethers.getContractFactory("BlockFinaXHedgeFacet");
  const hedgeFacet = await HedgeFacet.deploy();
  await hedgeFacet.waitForDeployment();
  const hedgeAddress = await hedgeFacet.getAddress();
  console.log("  HedgeFacet:     ", hedgeAddress);
  await wait(3000);

  // ────────────────────────────────────────────────────────────────────────────
  // 5. OracleFacet (multi-signer, auto-settle)
  // ────────────────────────────────────────────────────────────────────────────
  console.log("Deploying OracleFacet...");
  const OracleFacet = await hre.ethers.getContractFactory("BlockFinaXOracleFacet");
  const oracleFacet = await OracleFacet.deploy();
  await oracleFacet.waitForDeployment();
  const oracleAddress = await oracleFacet.getAddress();
  console.log("  OracleFacet:    ", oracleAddress);
  await wait(3000);

  // ────────────────────────────────────────────────────────────────────────────
  // Build selector lists
  // ────────────────────────────────────────────────────────────────────────────
  const loupeSelectors  = getSelectors(loupeFacet);
  const hedgeSelectors  = getSelectors(hedgeFacet);   // auto-discovers all functions incl. v6 additions
  const oracleSelectors = getSelectors(oracleFacet);

  console.log(
    `\nSelector counts — Loupe: ${loupeSelectors.length}, ` +
    `Hedge: ${hedgeSelectors.length}, Oracle: ${oracleSelectors.length}`
  );

  // ────────────────────────────────────────────────────────────────────────────
  // DiamondCut — add all three facets in one transaction
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\nAdding all facets to Diamond...");
  const facetCuts = [
    { facetAddress: loupeAddress,   action: 0, functionSelectors: loupeSelectors  },
    { facetAddress: hedgeAddress,   action: 0, functionSelectors: hedgeSelectors  },
    { facetAddress: oracleAddress,  action: 0, functionSelectors: oracleSelectors },
  ];

  const diamondCut = await hre.ethers.getContractAt("BlockFinaXDiamondCutFacet", diamondAddress);
  const cutTx = await diamondCut.diamondCut(facetCuts, hre.ethers.ZeroAddress, "0x");
  await cutTx.wait();
  console.log("  All facets registered. tx:", cutTx.hash);
  await wait(3000);

  // ────────────────────────────────────────────────────────────────────────────
  // Initialize hedge fees
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\nInitializing hedge fees...");
  const hedgeViaDiamond = await hre.ethers.getContractAt("BlockFinaXHedgeFacet", diamondAddress);
  const initTx = await hedgeViaDiamond.initializeHedgeFees(
    fees.eventCreationFee,
    fees.hedgerFeeRate,
    fees.hedgerPayoutFeeRate,
    fees.lpProfitFeeRate,
    fees.creatorLoyaltyRate,
  );
  await initTx.wait();
  console.log(`  Fees initialised: creation=${fees.eventCreationFee} ${tokenSymbol} · hedger=${fees.hedgerFeeRate/10n}bps · payout=${fees.hedgerPayoutFeeRate/10n}bps`);
  await wait(2000);

  // ────────────────────────────────────────────────────────────────────────────
  // Set oracle admin (deployer key is temporary — rotate post-deploy)
  // ────────────────────────────────────────────────────────────────────────────
  console.log("\nSetting oracle admin to deployer (temporary)...");
  const setAdminTx = await hedgeViaDiamond.setOracleAdmin(deployer.address);
  await setAdminTx.wait();
  console.log("  Oracle admin:", deployer.address);
  await wait(2000);

  // ────────────────────────────────────────────────────────────────────────────
  // Register oracle wallets if provided
  // ────────────────────────────────────────────────────────────────────────────
  const oracleAddresses = [
    process.env.ORACLE_A,
    process.env.ORACLE_B,
    process.env.ORACLE_C,
  ].filter(Boolean);

  let oraclesRegistered = 0;
  if (oracleAddresses.length > 0) {
    console.log(`\nRegistering ${oracleAddresses.length} oracle wallet(s)...`);
    const oracleViaDiamond = await hre.ethers.getContractAt("BlockFinaXOracleFacet", diamondAddress);

    for (const addr of oracleAddresses) {
      const addTx = await oracleViaDiamond.addOracle(addr);
      await addTx.wait();
      console.log("  + Oracle:", addr);
      oraclesRegistered++;
      await wait(2000);
    }

    if (oracleAddresses.length >= 2) {
      const setSignersTx = await oracleViaDiamond.setRequiredSigners(2);
      await setSignersTx.wait();
      console.log("  requiredSigners set to 2");
    }
  } else {
    console.log("\nNo ORACLE_A/B/C env vars set — oracle wallets must be registered post-deploy.");
  }

  // ────────────────────────────────────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────────────────────────────────────
  const divider = "=".repeat(60);
  console.log("\n" + divider);
  console.log(" DEPLOYMENT SUMMARY");
  console.log(divider);
  console.log("Network:              ", hre.network.name, `(chainId ${chainId})`);
  console.log("Diamond:              ", diamondAddress);
  console.log("");
  console.log("Facets:");
  console.log("  DiamondCutFacet:    ", diamondCutAddress);
  console.log("  DiamondLoupeFacet:  ", loupeAddress);
  console.log("  HedgeFacet:         ", hedgeAddress, `(${hedgeSelectors.length} selectors)`);
  console.log("  OracleFacet:        ", oracleAddress,  `(${oracleSelectors.length} selectors)`);
  console.log("");
  console.log("Config:");
  console.log("  USDC:               ", USDC_ADDRESS);
  console.log("  Deployer/Owner:     ", deployer.address);
  console.log("  Oracles registered: ", oraclesRegistered, "of 3");
  console.log(divider);
  console.log("");
  console.log("POST-DEPLOY CHECKLIST (do these in order):");
  console.log("  [ ] 1. Verify contracts on Blockscout (commands below)");
  console.log("  [ ] 2. Register oracle wallets if not done above:");
  console.log("         addOracle(ORACLE_A), addOracle(ORACLE_B), addOracle(ORACLE_C)");
  console.log("         setRequiredSigners(2)");
  console.log("  [ ] 3. Rotate ownership away from deployer key:");
  console.log("         transferOwnership(newOwnerAddr)  → then newOwner calls acceptOwnership()");
  console.log("  [ ] 4. Start oracle-node servers with ORACLE_KEY_A/B/C (never DEPLOYER_PRIVATE_KEY)");
  console.log("  [ ] 5. Update client/.env with new Diamond address and set VITE_NETWORK_MODE=mainnet");
  console.log("  [ ] 6. Smoke-test: createEvent → deposit → buyProtection → submitRate × 2 → claimPayout");
  console.log("  [ ] 7. Discard deployer key from all .env files once ownership transferred");
  console.log("");

  // ────────────────────────────────────────────────────────────────────────────
  // Verify commands
  // ────────────────────────────────────────────────────────────────────────────
  const net = hre.network.name;
  console.log("VERIFICATION COMMANDS:");
  console.log(`  npx hardhat verify --network ${net} ${diamondCutAddress}`);
  console.log(`  npx hardhat verify --network ${net} ${diamondAddress} ${deployer.address} ${diamondCutAddress} ${USDC_ADDRESS}`);
  console.log(`  npx hardhat verify --network ${net} ${loupeAddress}`);
  console.log(`  npx hardhat verify --network ${net} ${hedgeAddress}`);
  console.log(`  npx hardhat verify --network ${net} ${oracleAddress}`);
  console.log("");

  // ────────────────────────────────────────────────────────────────────────────
  // Save deployment JSON
  // ────────────────────────────────────────────────────────────────────────────
  const deploymentInfo = {
    standard: "EIP-2535 Diamond",
    network: hre.network.name,
    chainId,
    diamond: diamondAddress,
    facets: {
      blockFinaXDiamondCut:   diamondCutAddress,
      blockFinaXDiamondLoupe: loupeAddress,
      blockFinaXHedge:        hedgeAddress,
      blockFinaXOracle:       oracleAddress,
    },
    config: {
      paymentToken: USDC_ADDRESS,
      paymentTokenSymbol: tokenSymbol,
      hedgeFees: {
        eventCreationFee:    fees.eventCreationFee.toString(),
        hedgerFeeRate:       fees.hedgerFeeRate.toString(),
        hedgerPayoutFeeRate: fees.hedgerPayoutFeeRate.toString(),
        lpProfitFeeRate:     fees.lpProfitFeeRate.toString(),
        creatorLoyaltyRate:  fees.creatorLoyaltyRate.toString(),
      },
      oracleAdmin:          deployer.address,
      oraclesRegistered:    oracleAddresses,
    },
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
  };

  const filename = `deployments/deployments-diamond-${hre.network.name}.json`;
  fs.mkdirSync("deployments", { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(deploymentInfo, null, 2));
  console.log(`Deployment saved to ${filename}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\nDeployment failed:", error.message || error);
    process.exit(1);
  });
