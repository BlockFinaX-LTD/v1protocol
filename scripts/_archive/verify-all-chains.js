/**
 * verify-all-chains.js — Verify / re-verify all BlockFinaX contracts on
 *                         Base, BSC, and Lisk with correct names.
 *
 * Usage (from contracts/ directory):
 *   ETHERSCAN_API_KEY=<key> npx hardhat run scripts/verify-all-chains.js --network base
 *   ETHERSCAN_API_KEY=<key> npx hardhat run scripts/verify-all-chains.js --network bsc
 *   ETHERSCAN_API_KEY=<key> npx hardhat run scripts/verify-all-chains.js --network lisk
 */

const hre = require("hardhat");

// ── Per-chain deployment data ─────────────────────────────────────────────────

const CHAINS = {
  base: {
    label: "Base Mainnet (Basescan)",
    diamond: "0xcC594031d1c059Eb1d6bCb0c7b1c82D31115E6E6",
    diamondArgs: [
      "0xef5Bed7c221c85A2c88e3c0223ee45482d6F037d", // owner
      "0x3eDfA00a1E3C158A591097de2FA1756aCD66860D", // cutFacet
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC Base
    ],
    facets: {
      "src/facets/BlockFinaXDiamondCutFacet.sol:BlockFinaXDiamondCutFacet":   "0x3eDfA00a1E3C158A591097de2FA1756aCD66860D",
      "src/facets/BlockFinaXDiamondLoupeFacet.sol:BlockFinaXDiamondLoupeFacet":"0xCd84f1493497Dbaf5C1933907bD2D253a54233Bf",
      "src/facets/BlockFinaXHedgeFacet.sol:BlockFinaXHedgeFacet":             "0xA7af536A57eA2c20a3a3ae6B70b6943c78226f73",
      "src/facets/BlockFinaXOracleFacet.sol:BlockFinaXOracleFacet":           "0x2132f2ADB40ce3c353e15ae1139b7447FF3D3BFf",
      "src/facets/BlockFinaXTimelockCutFacet.sol:BlockFinaXTimelockCutFacet": "0xB264497FF0E64e3bbE216918927FdaC4EF202c4e",
    },
  },
  bsc: {
    label: "BSC Mainnet (BSCScan)",
    diamond: "0xcC594031d1c059Eb1d6bCb0c7b1c82D31115E6E6",
    diamondArgs: [
      "0xef5Bed7c221c85A2c88e3c0223ee45482d6F037d", // owner
      "0x3eDfA00a1E3C158A591097de2FA1756aCD66860D", // cutFacet
      "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // USDC BSC
    ],
    facets: {
      "src/facets/BlockFinaXDiamondCutFacet.sol:BlockFinaXDiamondCutFacet":   "0x3eDfA00a1E3C158A591097de2FA1756aCD66860D",
      "src/facets/BlockFinaXDiamondLoupeFacet.sol:BlockFinaXDiamondLoupeFacet":"0xCd84f1493497Dbaf5C1933907bD2D253a54233Bf",
      "src/facets/BlockFinaXHedgeFacet.sol:BlockFinaXHedgeFacet":             "0xA7af536A57eA2c20a3a3ae6B70b6943c78226f73",
      "src/facets/BlockFinaXOracleFacet.sol:BlockFinaXOracleFacet":           "0x2132f2ADB40ce3c353e15ae1139b7447FF3D3BFf",
      "src/facets/BlockFinaXTimelockCutFacet.sol:BlockFinaXTimelockCutFacet": "0xB264497FF0E64e3bbE216918927FdaC4EF202c4e",
    },
  },
  lisk: {
    label: "Lisk Mainnet (Blockscout)",
    diamond: "0x885E663645173a0791b82f0e6608921D31E3D700",
    diamondArgs: [
      "0xef5Bed7c221c85A2c88e3c0223ee45482d6F037d", // owner
      "0xb62Bb0A47Ff965d990b42752D9ceB34923FBae8b", // cutFacet (Lisk-specific)
      "0xF242275d3a6527d877f2c927a82D9b057609cc71", // USDC Lisk
    ],
    facets: {
      "src/facets/BlockFinaXDiamondCutFacet.sol:BlockFinaXDiamondCutFacet":   "0xb62Bb0A47Ff965d990b42752D9ceB34923FBae8b",
      "src/facets/BlockFinaXDiamondLoupeFacet.sol:BlockFinaXDiamondLoupeFacet":"0x4BC4C8574b0a49Ab1257ac6Ed7dd01a236ed0a66",
      "src/facets/BlockFinaXHedgeFacet.sol:BlockFinaXHedgeFacet":             "0x96aCAD2039F1796929Eba578C81fe12E8f23C989",
      "src/facets/BlockFinaXOracleFacet.sol:BlockFinaXOracleFacet":           "0xAEcE90e767E257dE7cd9C6E1e93cEb880575C394",
      "src/facets/BlockFinaXTimelockCutFacet.sol:BlockFinaXTimelockCutFacet": "0xaC939C0897981Abc0711ec4e37527F13106180fc",
    },
  },
};

// ── Helper ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function verify(address, contract, constructorArguments = []) {
  const label = contract.split(":").pop();
  try {
    process.stdout.write(`  ▶  ${label} @ ${address.slice(0,10)}... `);
    await hre.run("verify:verify", {
      address,
      contract,
      constructorArguments,
      force: true, // re-verify even if already verified — updates name
    });
    console.log("✅");
  } catch (err) {
    const msg = err.message || "";
    if (/already.verified/i.test(msg)) {
      // Already verified with same name — fine
      console.log("☑  (already verified, name unchanged)");
    } else if (/does not match/i.test(msg) || /bytecode/i.test(msg)) {
      console.log(`⚠  Bytecode mismatch — ${msg.split("\n")[0]}`);
    } else {
      console.log(`❌  ${msg.split("\n")[0]}`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const network = hre.network.name;
  const chain = CHAINS[network];

  if (!chain) {
    console.error(`❌ Unknown network: ${network}`);
    console.error(`   Run with: --network base | bsc | lisk`);
    process.exit(1);
  }

  console.log(`\n${"═".repeat(66)}`);
  console.log(` BlockFinaX — ${chain.label}`);
  console.log(`${"═".repeat(66)}`);

  console.log("\n── Facets ──");
  for (const [contract, address] of Object.entries(chain.facets)) {
    await verify(address, contract);
    await sleep(4000); // avoid rate limits (3 req/sec max)
  }

  console.log("\n── Diamond proxy (BlockFinaXDiamond) ──");
  await sleep(4000);
  await verify(chain.diamond, "src/Diamond.sol:BlockFinaXDiamond", chain.diamondArgs);

  console.log(`\n${"═".repeat(66)}`);
  console.log(` Finished. All contracts should now show "BlockFinaX" on the explorer.`);
  console.log(`${"═".repeat(66)}\n`);
}

main().catch(console.error);
