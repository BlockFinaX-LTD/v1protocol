/**
 * verify-base-bsc.js — Verify all BlockFinaX contracts on Base and BSC
 *
 * Usage (from contracts/ directory):
 *   ETHERSCAN_API_KEY=<key> npx hardhat run scripts/verify-base-bsc.js --network base
 *   ETHERSCAN_API_KEY=<key> npx hardhat run scripts/verify-base-bsc.js --network bsc
 */

const hre = require("hardhat");

// ── Contract addresses ────────────────────────────────────────────────────────

const FACETS = {
  "src/facets/BlockFinaXDiamondCutFacet.sol:BlockFinaXDiamondCutFacet":   "0x3eDfA00a1E3C158A591097de2FA1756aCD66860D",
  "src/facets/BlockFinaXDiamondLoupeFacet.sol:BlockFinaXDiamondLoupeFacet":"0xCd84f1493497Dbaf5C1933907bD2D253a54233Bf",
  "src/facets/BlockFinaXHedgeFacet.sol:BlockFinaXHedgeFacet":             "0xA7af536A57eA2c20a3a3ae6B70b6943c78226f73",
  "src/facets/BlockFinaXOracleFacet.sol:BlockFinaXOracleFacet":           "0x2132f2ADB40ce3c353e15ae1139b7447FF3D3BFf",
  "src/facets/BlockFinaXTimelockCutFacet.sol:BlockFinaXTimelockCutFacet": "0xB264497FF0E64e3bbE216918927FdaC4EF202c4e",
};

const DIAMOND_ADDRESS = "0xcC594031d1c059Eb1d6bCb0c7b1c82D31115E6E6";
const OWNER           = "0xef5Bed7c221c85A2c88e3c0223ee45482d6F037d";
const CUT_FACET       = "0x3eDfA00a1E3C158A591097de2FA1756aCD66860D";

const USDC = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  bsc:  "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
};

// ── Helper ────────────────────────────────────────────────────────────────────

async function verify(address, contract, constructorArguments = []) {
  const label = contract.split(":").pop();
  try {
    process.stdout.write(`\n▶  Verifying ${label} @ ${address} ... `);
    await hre.run("verify:verify", { address, contract, constructorArguments });
    console.log("✅");
  } catch (err) {
    if (/already.verified/i.test(err.message) || /Already Verified/i.test(err.message)) {
      console.log("☑  (already verified)");
    } else {
      console.log(`❌  ${err.message.split("\n")[0]}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const network = hre.network.name;
  if (!["base", "bsc"].includes(network)) {
    console.error(`Run with --network base  or  --network bsc`);
    process.exit(1);
  }

  console.log(`\n${"═".repeat(64)}`);
  console.log(` BlockFinaX contract verification — ${network === "base" ? "Base Mainnet (Basescan)" : "BSC Mainnet (BSCScan)"}`);
  console.log(`${"═".repeat(64)}`);

  // 1. Verify all facets (no constructor args)
  console.log("\n── Facets ──");
  for (const [contract, address] of Object.entries(FACETS)) {
    await verify(address, contract);
  }

  // 2. Verify the Diamond proxy with constructor args
  console.log("\n── Diamond proxy ──");
  await verify(
    DIAMOND_ADDRESS,
    "src/Diamond.sol:Diamond",
    [OWNER, CUT_FACET, USDC[network]]
  );

  console.log(`\n${"═".repeat(64)}`);
  console.log(" Done. Check Basescan/BSCScan — verified contracts show source + ABI.");
  console.log(`${"═".repeat(64)}\n`);
}

main().catch(console.error);
