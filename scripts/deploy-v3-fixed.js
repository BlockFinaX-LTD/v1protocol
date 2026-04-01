/**
 * deploy-v3-fixed.js — BlockFinaX Diamond v3 Security-Fixed Deployment
 *
 * Deploys a fully audited, clean Diamond system fixing all critical/high/medium findings:
 *
 * Security fixes included (from audit report):
 *   C-01 — DiamondCutFacet atomically replaced by TimelockCutFacet in same tx
 *   H-01 — claimPremiums() blocks claims after withdrawCapital()
 *   H-02 — recoverExpiredPayouts() reconciles against actual token balance
 *   H-03 — _clearSubmissions() also resets oracle cooldown timestamps
 *   M-01 — setOracleAdmin() comment corrected re: post-activateOracleV2() behaviour
 *   M-02 — createEvent() caps priceDelta at 10x initialRate
 *   M-03 — deposit() requires shares > 0
 *   M-04 — TimelockCutFacet proposalId includes nonce to prevent collisions
 *   L-03 — rescueETH() caps call gas at 2300
 *   L-05 — setPoolSettings() is now nonReentrant
 *
 * Deployment order:
 *   1. BlockFinaXDiamondCutFacet       (bootstrap — needed for Diamond constructor)
 *   2. Diamond proxy                    (owner = deployer, USDC = per-chain config)
 *   3. BlockFinaXDiamondLoupeFacet
 *   4. BlockFinaXHedgeFacet
 *   5. BlockFinaXOracleFacet
 *   6. BlockFinaXTimelockCutFacet
 *   7. DiamondCut: add Loupe + Hedge + Oracle  AND  atomically remove DiamondCutFacet
 *                  + add TimelockCutFacet  (C-01 fix — no gap where raw cut is live)
 *   8. initializeHedgeFees()
 *   9. setOracleAdmin(ORACLE_ADMIN or deployer)
 *  10. addOracle(A/B/C) + setRequiredSigners(2)  if ORACLE_A/B/C env vars present
 *  11. activateOracleV2()                         if ACTIVATE_ORACLE_V2=true
 *  12. transferOwnership(SAFE_ADDR)              if SAFE_ADDR env var present
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY   — funds gas, is initially the Diamond owner
 *
 * Optional env vars:
 *   ORACLE_A / ORACLE_B / ORACLE_C  — oracle node wallet addresses
 *   ORACLE_ADMIN                    — address for single-key oracle admin (defaults to deployer)
 *   SAFE_ADDR                       — Safe multisig to transfer Diamond ownership to post-deploy
 *   ACTIVATE_ORACLE_V2              — set to "true" to permanently activate multi-oracle mode
 *   USDC_OVERRIDE                   — override USDC address (useful for forked testnets)
 *
 * Usage:
 *   npx hardhat run scripts/deploy-v3-fixed.js --network lisk
 *   npx hardhat run scripts/deploy-v3-fixed.js --network liskSepolia
 */

const hre = require("hardhat");
const fs  = require("fs");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Canonical USDC addresses per chainId. */
const USDC_ADDRESSES = {
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  4202:  "0xf52Ad63619Bf9cFeF510341ac6b4038554399562", // Lisk Sepolia
  8453:  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Base Mainnet
  1135:  "0xF242275d3a6527d877f2c927a82D9b057609cc71", // Lisk Mainnet
};

/**
 * Return every non-constructor function selector from a deployed contract.
 * Filters out any selector that matches IDiamondCut.diamondCut so the bootstrap
 * facet selector is managed explicitly and not double-added.
 */
function getSelectors(contract, { exclude = [] } = {}) {
  const excludeSet = new Set(exclude);
  return contract.interface.fragments
    .filter(f => f.type === "function")
    .map(f => contract.interface.getFunction(f.name).selector)
    .filter(sel => !excludeSet.has(sel));
}

async function deploy(factoryName, ...args) {
  const Factory = await hre.ethers.getContractFactory(factoryName);
  const instance = await Factory.deploy(...args);
  await instance.waitForDeployment();
  const addr = await instance.getAddress();
  console.log(`  ${factoryName}: ${addr}`);
  await wait(3000);
  return instance;
}

async function main() {
  const BAR = "=".repeat(62);
  console.log("\n" + BAR);
  console.log(" BlockFinaX Diamond — v3 SECURITY-FIXED DEPLOYMENT");
  console.log(BAR + "\n");

  const [deployer] = await hre.ethers.getSigners();
  const network    = await hre.ethers.provider.getNetwork();
  const chainId    = Number(network.chainId);

  console.log("Network:   ", hre.network.name, `(chainId ${chainId})`);
  console.log("Deployer:  ", deployer.address);
  const bal = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:   ", hre.ethers.formatEther(bal), "ETH\n");
  if (bal === 0n) throw new Error("Deployer balance is zero — fund the wallet first.");

  const USDC_ADDRESS =
    process.env.USDC_OVERRIDE ||
    USDC_ADDRESSES[chainId];
  if (!USDC_ADDRESS) {
    throw new Error(
      `No USDC configured for chainId ${chainId}. ` +
      "Set USDC_OVERRIDE or add it to USDC_ADDRESSES in the script."
    );
  }
  console.log("USDC:      ", USDC_ADDRESS, "\n");

  // ─────────────────────────────────────────────────────────────────────────
  // 1. Bootstrap DiamondCutFacet (only needed for Diamond constructor)
  // ─────────────────────────────────────────────────────────────────────────
  console.log("Step 1: Deploy DiamondCutFacet (bootstrap)...");
  const cutFacet     = await deploy("BlockFinaXDiamondCutFacet");
  const cutAddress   = await cutFacet.getAddress();
  const DIAMOND_CUT_SELECTOR = cutFacet.interface.getFunction("diamondCut").selector;

  // ─────────────────────────────────────────────────────────────────────────
  // 2. Diamond proxy
  // ─────────────────────────────────────────────────────────────────────────
  console.log("Step 2: Deploy Diamond proxy...");
  const diamond      = await deploy("Diamond", deployer.address, cutAddress, USDC_ADDRESS);
  const DIAMOND      = await diamond.getAddress();

  // ─────────────────────────────────────────────────────────────────────────
  // 3–6. Facets
  // ─────────────────────────────────────────────────────────────────────────
  console.log("Step 3: Deploy DiamondLoupeFacet...");
  const loupeFacet   = await deploy("BlockFinaXDiamondLoupeFacet");

  console.log("Step 4: Deploy HedgeFacet (all audit fixes applied)...");
  const hedgeFacet   = await deploy("BlockFinaXHedgeFacet");

  console.log("Step 5: Deploy OracleFacet (H-03 fix applied)...");
  const oracleFacet  = await deploy("BlockFinaXOracleFacet");

  console.log("Step 6: Deploy TimelockCutFacet (M-04 fix + executeCut/cancelCut API)...");
  const timelockFacet = await deploy("BlockFinaXTimelockCutFacet");
  const timelockAddr  = await timelockFacet.getAddress();

  // ─────────────────────────────────────────────────────────────────────────
  // 7. Single atomic diamondCut:
  //    a. Add LoupeFacet selectors        (action = 0 = Add)
  //    b. Add HedgeFacet selectors        (action = 0 = Add)
  //    c. Add OracleFacet selectors       (action = 0 = Add)
  //    d. Add TimelockCutFacet selectors  (action = 0 = Add)
  //       — includes the diamondCut(bytes32,address,bytes) selector
  //    e. Remove the bootstrap DiamondCutFacet selector  (action = 2 = Remove)
  //
  // C-01 fix: steps (d) and (e) are in the same transaction — there is never a
  // moment where both the raw DiamondCutFacet AND the TimelockCutFacet are live.
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\nStep 7: Atomic DiamondCut — add all facets + swap to TimelockCutFacet...");

  const loupeSelectors    = getSelectors(loupeFacet);
  const hedgeSelectors    = getSelectors(hedgeFacet);
  const oracleSelectors   = getSelectors(oracleFacet);
  const timelockSelectors = getSelectors(timelockFacet);

  console.log(
    `  Selectors — Loupe: ${loupeSelectors.length}, ` +
    `Hedge: ${hedgeSelectors.length}, ` +
    `Oracle: ${oracleSelectors.length}, ` +
    `Timelock: ${timelockSelectors.length}`
  );

  const facetCuts = [
    // Add facets
    { facetAddress: await loupeFacet.getAddress(),   action: 0, functionSelectors: loupeSelectors    },
    { facetAddress: await hedgeFacet.getAddress(),   action: 0, functionSelectors: hedgeSelectors    },
    { facetAddress: await oracleFacet.getAddress(),  action: 0, functionSelectors: oracleSelectors   },
    // Add TimelockCutFacet (includes the diamondCut selector — replaces the bootstrap one)
    { facetAddress: timelockAddr,                    action: 0, functionSelectors: timelockSelectors },
    // Remove the bootstrap DiamondCutFacet's diamondCut selector (C-01 fix)
    // The TimelockCutFacet's diamondCut selector was already added above, so
    // Diamond.fallback() will now route diamondCut() to the timelocked version.
    // We remove the *old* facet address mapping by removing its selector list,
    // which is just the single diamondCut selector.
    { facetAddress: hre.ethers.ZeroAddress,          action: 2, functionSelectors: [DIAMOND_CUT_SELECTOR] },
  ];

  const diamondCutViaBootstrap = await hre.ethers.getContractAt(
    "BlockFinaXDiamondCutFacet",
    DIAMOND
  );
  const cutTx = await diamondCutViaBootstrap.diamondCut(
    facetCuts,
    hre.ethers.ZeroAddress,
    "0x"
  );
  await cutTx.wait();
  console.log("  All facets added + DiamondCutFacet removed. tx:", cutTx.hash);
  await wait(3000);

  // Quick sanity: any call to diamondCut() now goes through TimelockCutFacet.
  // Verify by checking the loupe.
  const loupe = await hre.ethers.getContractAt("BlockFinaXDiamondLoupeFacet", DIAMOND);
  const timelockViaLoupe = await loupe.facetAddress(DIAMOND_CUT_SELECTOR);
  if (timelockViaLoupe.toLowerCase() !== timelockAddr.toLowerCase()) {
    throw new Error(
      `C-01 assertion failed: diamondCut selector routes to ${timelockViaLoupe} ` +
      `(expected TimelockCutFacet at ${timelockAddr})`
    );
  }
  console.log("  C-01 assertion PASSED: diamondCut() → TimelockCutFacet ✓");

  // ─────────────────────────────────────────────────────────────────────────
  // 8. Initialize hedge fees
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\nStep 8: Initialize hedge fees...");
  const hedge = await hre.ethers.getContractAt("BlockFinaXHedgeFacet", DIAMOND);
  const feeTx = await hedge.initializeHedgeFees(
    25_000_000,   // eventCreationFee  = $25.00 USDC  (6 dec)
    5_000,        // hedgerFeeRate     = 0.5%
    10_000,       // hedgerPayoutFeeRate = 1.0%
    10_000,       // lpProfitFeeRate   = 1.0%
    50_000        // creatorLoyaltyRate = 5.0%
  );
  await feeTx.wait();
  console.log("  Fees: $25 creation · 0.5% hedger · 1.0% payout · 1.0% LP · 5.0% creator");
  await wait(2000);

  // ─────────────────────────────────────────────────────────────────────────
  // 9. Set oracle admin (rotate to dedicated key or deployer)
  // ─────────────────────────────────────────────────────────────────────────
  const oracleAdmin = process.env.ORACLE_ADMIN || deployer.address;
  console.log(`\nStep 9: Set oracle admin → ${oracleAdmin}...`);
  const adminTx = await hedge.setOracleAdmin(oracleAdmin);
  await adminTx.wait();
  await wait(2000);

  // ─────────────────────────────────────────────────────────────────────────
  // 10. Register oracle wallets
  // ─────────────────────────────────────────────────────────────────────────
  const oracleAddresses = [
    process.env.ORACLE_A,
    process.env.ORACLE_B,
    process.env.ORACLE_C,
  ].filter(Boolean);

  let oraclesRegistered = 0;
  if (oracleAddresses.length > 0) {
    console.log(`\nStep 10: Register ${oracleAddresses.length} oracle wallet(s)...`);
    const oracle = await hre.ethers.getContractAt("BlockFinaXOracleFacet", DIAMOND);

    for (const addr of oracleAddresses) {
      const tx = await oracle.addOracle(addr);
      await tx.wait();
      console.log("  + Oracle:", addr);
      oraclesRegistered++;
      await wait(2000);
    }

    if (oracleAddresses.length >= 2) {
      const signersTx = await oracle.setRequiredSigners(2);
      await signersTx.wait();
      console.log("  requiredSigners → 2");
      await wait(2000);
    }
  } else {
    console.log("\nStep 10: SKIPPED — no ORACLE_A/B/C env vars set.");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 11. Activate OracleV2 (optional — permanently disables single-key settle)
  // ─────────────────────────────────────────────────────────────────────────
  if (process.env.ACTIVATE_ORACLE_V2 === "true") {
    if (oraclesRegistered < 2) {
      console.log("\nStep 11: SKIPPED — ACTIVATE_ORACLE_V2=true but < 2 oracles registered. Register first.");
    } else {
      console.log("\nStep 11: Activating OracleV2 (permanent — disables single-key settlement)...");
      const v2Tx = await hedge.activateOracleV2();
      await v2Tx.wait();
      console.log("  OracleV2 activated. settleEvent() permanently disabled.");
      await wait(2000);
    }
  } else {
    console.log("\nStep 11: SKIPPED — set ACTIVATE_ORACLE_V2=true to enable after oracle testing.");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 12. Transfer Diamond ownership to Safe (optional)
  // ─────────────────────────────────────────────────────────────────────────
  const SAFE_ADDR = process.env.SAFE_ADDR;
  if (SAFE_ADDR) {
    console.log(`\nStep 12: Proposing ownership transfer to Safe at ${SAFE_ADDR}...`);
    const xferTx = await hedge.transferOwnership(SAFE_ADDR);
    await xferTx.wait();
    console.log("  Pending — Safe must call acceptOwnership() to complete transfer.");
    await wait(2000);
  } else {
    console.log("\nStep 12: SKIPPED — set SAFE_ADDR to transfer ownership to a Safe multisig.");
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n" + BAR);
  console.log(" DEPLOYMENT SUMMARY");
  console.log(BAR);
  console.log("Network:             ", hre.network.name, `(chainId ${chainId})`);
  console.log("Diamond:             ", DIAMOND);
  console.log("");
  console.log("Facets:");
  console.log("  DiamondCutFacet (bootstrap, removed):  ", cutAddress);
  console.log("  DiamondLoupeFacet:                    ", await loupeFacet.getAddress());
  console.log("  HedgeFacet:                           ", await hedgeFacet.getAddress(), `(${hedgeSelectors.length} selectors)`);
  console.log("  OracleFacet:                          ", await oracleFacet.getAddress(), `(${oracleSelectors.length} selectors)`);
  console.log("  TimelockCutFacet:                     ", timelockAddr, `(${timelockSelectors.length} selectors)`);
  console.log("");
  console.log("Config:");
  console.log("  USDC:                                 ", USDC_ADDRESS);
  console.log("  Oracle admin:                         ", oracleAdmin);
  console.log("  Oracles registered:                   ", oraclesRegistered, "of", oracleAddresses.length || "0 (none provided)");
  console.log("  OracleV2 active:                      ", process.env.ACTIVATE_ORACLE_V2 === "true" && oraclesRegistered >= 2);
  console.log("  Pending owner:                        ", SAFE_ADDR || deployer.address + " (no transfer requested)");
  console.log(BAR);

  console.log("\nPOST-DEPLOY CHECKLIST (complete in order):");
  console.log("  [ ] 1. Verify all contracts on Blockscout (commands below)");
  console.log("  [ ] 2. If ORACLE_A/B/C not set above, register them and call setRequiredSigners(2)");
  console.log("  [ ] 3. If ACTIVATE_ORACLE_V2 not set, test oracle flow then activate:");
  console.log("         activateOracleV2()  — permanently disables single-key settlement");
  console.log("  [ ] 4. If SAFE_ADDR not set, transfer ownership:");
  console.log("         transferOwnership(safeAddr)  → Safe calls acceptOwnership()");
  console.log("  [ ] 5. Update client/.env VITE_CONTRACT_ADDRESS=" + DIAMOND);
  console.log("  [ ] 6. Smoke-test: createEvent → deposit → buyProtection → submitRate×2 → claim");
  console.log("  [ ] 7. Discard DEPLOYER_PRIVATE_KEY from all .env files once ownership transferred");
  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // Verification commands
  // ─────────────────────────────────────────────────────────────────────────
  const net = hre.network.name;
  console.log("VERIFICATION COMMANDS:");
  console.log(`  npx hardhat verify --network ${net} ${cutAddress}`);
  console.log(`  npx hardhat verify --network ${net} ${DIAMOND} "${deployer.address}" "${cutAddress}" "${USDC_ADDRESS}"`);
  console.log(`  npx hardhat verify --network ${net} ${await loupeFacet.getAddress()}`);
  console.log(`  npx hardhat verify --network ${net} ${await hedgeFacet.getAddress()}`);
  console.log(`  npx hardhat verify --network ${net} ${await oracleFacet.getAddress()}`);
  console.log(`  npx hardhat verify --network ${net} ${timelockAddr}`);
  console.log("");

  // ─────────────────────────────────────────────────────────────────────────
  // Save deployment JSON
  // ─────────────────────────────────────────────────────────────────────────
  const deploymentInfo = {
    version: "v3-fixed",
    standard: "EIP-2535 Diamond",
    auditFixesApplied: ["C-01","H-01","H-02","H-03","M-01","M-02","M-03","M-04","L-03","L-05"],
    network: hre.network.name,
    chainId,
    diamond: DIAMOND,
    facets: {
      bootstrapDiamondCutFacet: cutAddress,
      blockFinaXDiamondLoupe:   await loupeFacet.getAddress(),
      blockFinaXHedge:          await hedgeFacet.getAddress(),
      blockFinaXOracle:         await oracleFacet.getAddress(),
      blockFinaXTimelockCut:    timelockAddr,
    },
    config: {
      usdcToken:    USDC_ADDRESS,
      oracleAdmin,
      hedgeFees: {
        eventCreationFee:    "25000000",
        hedgerFeeRate:       "5000",
        hedgerPayoutFeeRate: "10000",
        lpProfitFeeRate:     "10000",
        creatorLoyaltyRate:  "50000",
      },
      oraclesRegistered: oracleAddresses,
      oracleV2Active: process.env.ACTIVATE_ORACLE_V2 === "true" && oraclesRegistered >= 2,
      pendingOwner: SAFE_ADDR || null,
    },
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
  };

  const filename = `deployments-v3-fixed-${hre.network.name}-${Date.now()}.json`;
  fs.writeFileSync(filename, JSON.stringify(deploymentInfo, null, 2));
  console.log(`Deployment info saved → ${filename}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nDeployment FAILED:", err.message || err);
    process.exit(1);
  });
