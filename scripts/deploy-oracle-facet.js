/**
 * deploy-oracle-facet.js
 *
 * Deploys BlockFinaXOracleFacet and cuts it into an existing Diamond.
 *
 * ISOLATION: This script only adds new function selectors to the Diamond.
 *            It does not remove or replace any existing facet functions.
 *            The existing HedgeFacet.settleEvent() single-key path remains
 *            active and unchanged.
 *
 * Usage:
 *   DIAMOND_ADDRESS=0x... ORACLE_A=0x... ORACLE_B=0x... ORACLE_C=0x... \
 *     npx hardhat run scripts/deploy-oracle-facet.js --network baseSepolia
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY  — Diamond owner wallet
 *   DIAMOND_ADDRESS       — Existing Diamond contract address
 *
 * Optional env vars (register oracle wallets after deployment):
 *   ORACLE_A              — Oracle A wallet address
 *   ORACLE_B              — Oracle B wallet address
 *   ORACLE_C              — Oracle C wallet address
 */

const hre = require("hardhat");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getSelectors(contract) {
  return contract.interface.fragments
    .filter((f) => f.type === "function")
    .map((f) => f.selector);
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:        ", deployer.address);

  const DIAMOND_ADDRESS = process.env.DIAMOND_ADDRESS;
  if (!DIAMOND_ADDRESS) {
    throw new Error("Set DIAMOND_ADDRESS env var to the existing Diamond address");
  }
  console.log("Diamond address: ", DIAMOND_ADDRESS);

  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:         ", hre.ethers.formatEther(balance), "ETH\n");

  console.log("Deploying BlockFinaXOracleFacet...");
  const OracleFacet = await hre.ethers.getContractFactory("BlockFinaXOracleFacet");
  const oracleFacet = await OracleFacet.deploy();
  await oracleFacet.waitForDeployment();
  const oracleFacetAddress = await oracleFacet.getAddress();
  console.log("OracleFacet deployed:", oracleFacetAddress);
  await wait(3000);

  const selectors = getSelectors(oracleFacet);
  console.log("\nFunction selectors to add:", selectors.length);
  selectors.forEach((sel) => {
    const frag = oracleFacet.interface.fragments.find(
      (f) => f.type === "function" && f.selector === sel
    );
    console.log(`  ${sel}  ${frag ? frag.name : "unknown"}`);
  });

  const DiamondCut = await hre.ethers.getContractAt(
    "BlockFinaXDiamondCutFacet",
    DIAMOND_ADDRESS
  );

  const FacetCutAction = { Add: 0, Replace: 1, Remove: 2 };

  const cut = [
    {
      facetAddress: oracleFacetAddress,
      action: FacetCutAction.Add,
      functionSelectors: selectors,
    },
  ];

  console.log("\nExecuting diamondCut to add OracleFacet...");
  const tx = await DiamondCut.diamondCut(cut, hre.ethers.ZeroAddress, "0x");
  const receipt = await tx.wait();
  console.log("DiamondCut tx:   ", receipt.hash);
  await wait(3000);

  console.log("\nOracleFacet successfully cut into Diamond.");

  const ORACLE_A = process.env.ORACLE_A;
  const ORACLE_B = process.env.ORACLE_B;
  const ORACLE_C = process.env.ORACLE_C;
  const oracleAddresses = [ORACLE_A, ORACLE_B, ORACLE_C].filter(Boolean);

  if (oracleAddresses.length > 0) {
    console.log("\nRegistering oracle wallets...");
    const oracleFacetViaDiamond = await hre.ethers.getContractAt(
      "BlockFinaXOracleFacet",
      DIAMOND_ADDRESS
    );

    for (const addr of oracleAddresses) {
      console.log("  Adding oracle:", addr);
      const addTx = await oracleFacetViaDiamond.addOracle(addr);
      await addTx.wait();
      await wait(2000);
    }

    if (oracleAddresses.length >= 2) {
      console.log("\nSetting requiredSigners to 2...");
      const setTx = await oracleFacetViaDiamond.setRequiredSigners(2);
      await setTx.wait();
    }

    console.log("\nOracle config set:");
    const config = await oracleFacetViaDiamond.getOracleConfig();
    console.log("  Required signers:", config.requiredSigners.toString());
    console.log("  Tolerance (bps): ", config.toleranceBps.toString(), "(1% default)");
    console.log("  Oracle count:    ", config.oracleCount.toString());
  } else {
    console.log(
      "\nNo ORACLE_A / ORACLE_B / ORACLE_C env vars set — " +
      "add oracle wallets manually via addOracle() after deployment."
    );
  }

  console.log("\n=== Deployment complete ===");
  console.log("OracleFacet address:", oracleFacetAddress);
  console.log("Diamond address:    ", DIAMOND_ADDRESS);
  console.log(
    "\nNext steps:\n" +
    "  1. Start oracle-a, oracle-b, oracle-c server processes with ORACLE_KEY_A/B/C\n" +
    "  2. Verify oracle wallets match registered addresses via getOracles()\n" +
    "  3. Optional: stop using DEPLOYER_PRIVATE_KEY single-key oracle once multi-key is verified"
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
