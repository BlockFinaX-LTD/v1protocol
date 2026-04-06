/**
 * verify-base-bsc.js — Verify all BlockFinaX contracts on Base and BSC
 *
 * Usage (from contracts/ directory):
 *   ETHERSCAN_API_KEY=<key> npx hardhat run scripts/verify-base-bsc.js --network base
 *   ETHERSCAN_API_KEY=<key> npx hardhat run scripts/verify-base-bsc.js --network bsc
 */

const hre = require("hardhat");

// ── Per-chain deployment data (new diamonds deployed 2025-04-06) ──────────────

const CHAINS = {
  base: {
    label:   "Base Mainnet (Basescan)",
    diamond: "0xbCC51E62C4948FD35ab505bd71804C849601e4Ef",
    owner:   "0xef5Bed7c221c85A2c88e3c0223ee45482d6F037d",
    token:   "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC Base
    facets: {
      "src/facets/BlockFinaXDiamondCutFacet.sol:BlockFinaXDiamondCutFacet":    "0x31098B8fF039cfb400bee2c272004dcf03C2AF06",
      "src/facets/BlockFinaXDiamondLoupeFacet.sol:BlockFinaXDiamondLoupeFacet": "0x45D2Af764B7Eb38E7A6922b84c1dE00c198A208e",
      "src/facets/BlockFinaXHedgeFacet.sol:BlockFinaXHedgeFacet":              "0x66aF6cA48f80A6d9e838aAF152c71eD26ed82F66",
      "src/facets/BlockFinaXOracleFacet.sol:BlockFinaXOracleFacet":            "0x1bba706e69F3a49c971E7e639b039fcBd4447E86",
    },
  },
  bsc: {
    label:   "BSC Mainnet (BSCScan)",
    diamond: "0xaC939C0897981Abc0711ec4e37527F13106180fc",
    owner:   "0xef5Bed7c221c85A2c88e3c0223ee45482d6F037d",
    token:   "0x55d398326f99059fF775485246999027B3197955", // USDT BSC (18 dec)
    facets: {
      "src/facets/BlockFinaXDiamondCutFacet.sol:BlockFinaXDiamondCutFacet":    "0xAEcE90e767E257dE7cd9C6E1e93cEb880575C394",
      "src/facets/BlockFinaXDiamondLoupeFacet.sol:BlockFinaXDiamondLoupeFacet": "0x8dD38f78a34b12f967c635252FB03b2f055988f6",
      "src/facets/BlockFinaXHedgeFacet.sol:BlockFinaXHedgeFacet":              "0x94e1436180C4c577D98e769D1830F39f62F0b122",
      "src/facets/BlockFinaXOracleFacet.sol:BlockFinaXOracleFacet":            "0x090a3cC9A71e2272f6a681C2bA940C71D36c239f",
      // rescueERC20 upgrade — new HedgeFacet deployed by upgrade-rescue-erc20.js
      // Only the rescueERC20 selector routes here; verify as HedgeFacet
      "src/facets/BlockFinaXHedgeFacet.sol:BlockFinaXHedgeFacet#rescue":       "0x770F0E947E9a838091dC4ddc33D85B79799DF33A",
    },
  },
};

// ── Helper ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function verify(address, contract, constructorArguments = []) {
  const label = contract.split(":").pop();
  try {
    process.stdout.write(`\n  ▶  ${label} @ ${address} ... `);
    await hre.run("verify:verify", {
      address,
      contract: contract.replace("#rescue", ""), // strip alias suffix
      constructorArguments,
    });
    console.log("✅");
  } catch (err) {
    const msg = err.message || "";
    if (/already.verified/i.test(msg) || /Already Verified/i.test(msg)) {
      console.log("☑  (already verified)");
    } else if (/bytecode/i.test(msg) || /does not match/i.test(msg)) {
      console.log(`⚠  Bytecode mismatch — ${msg.split("\n")[0]}`);
    } else {
      console.log(`❌  ${msg.split("\n")[0]}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const network = hre.network.name;
  const chain   = CHAINS[network];

  if (!chain) {
    console.error(`Run with --network base  or  --network bsc`);
    process.exit(1);
  }

  console.log(`\n${"═".repeat(66)}`);
  console.log(` BlockFinaX contract verification — ${chain.label}`);
  console.log(`${"═".repeat(66)}`);

  // 1. Verify facets (no constructor args)
  console.log("\n── Facets ──");
  for (const [contract, address] of Object.entries(chain.facets)) {
    await verify(address, contract);
    await sleep(4000);
  }

  // 2. Verify the Diamond proxy with constructor args
  console.log("\n── Diamond proxy ──");
  await sleep(4000);
  const cutFacetAddress = Object.values(chain.facets)[0]; // first = DiamondCutFacet
  await verify(
    chain.diamond,
    "src/Diamond.sol:Diamond",
    [chain.owner, cutFacetAddress, chain.token]
  );

  console.log(`\n${"═".repeat(66)}`);
  console.log(" Done. Check Basescan/BSCScan — verified contracts show source + ABI.");
  console.log(`${"═".repeat(66)}\n`);
}

main().catch(console.error);
