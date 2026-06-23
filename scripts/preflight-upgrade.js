/**
 * preflight-upgrade.js — READ-ONLY safety check before a mainnet facet upgrade.
 * Broadcasts nothing. Run per network:
 *   npx hardhat run scripts/preflight-upgrade.js --network base
 *   npx hardhat run scripts/preflight-upgrade.js --network bsc
 *
 * Reports:
 *   - deployer address + native gas balance
 *   - the Diamond's current owner, and whether the deployer is the owner (can it cut?)
 *   - whether the timelock is installed (would a direct cut even apply?)
 *   - total events, and how many are still OPEN with live hedger positions
 *     (these are the positions whose settlement rules the European upgrade would change)
 */

const hre = require("hardhat");
const { ethers } = hre;

const CHAINS = {
  8453: { env: "BASE_DIAMOND_ADDRESS", label: "Base" },
  56:   { env: "BSC_DIAMOND_ADDRESS",  label: "BSC" },
  84532:{ env: "BASE_DIAMOND_ADDRESS", label: "Base Sepolia" },
  97:   { env: "BSC_DIAMOND_ADDRESS",  label: "BSC testnet" },
};

const DS_POS = ethers.keccak256(ethers.toUtf8Bytes("diamond.standard.diamond.storage"));
const OWNER_SLOT = "0x" + (BigInt(DS_POS) + 4n).toString(16).padStart(64, "0");

const ABI = [
  "function getTotalHedgeEvents() view returns (uint256)",
  "function getHedgeEventCore(uint256) view returns (uint256 id,address creator,string name,string underlying,uint256 strike,uint256 premiumRate,uint256 expiryDate,uint8 status,bool poolOpen,bool allowExternalLp,uint256 initialRate,bool strikeAbove)",
  "function getEventPositionIds(uint256) view returns (uint256[])",
  "function getHedgeEventStats(uint256) view returns (uint256 settlementPrice,bool triggered,uint256 settledAt,uint256 creatorEarnings,uint256 totalLiquidity,uint256 totalExposure,uint256 totalPremiums,uint256 lpCount,uint256 hedgerCount,uint256 totalMaxPayout)",
  "function getPricingEngineSigner() view returns (address)",
];
const LOUPE_ABI = ["function facetAddress(bytes4) view returns (address)"];
const EXEC_SEL = ethers.id("executeCut(bytes32)").slice(0, 10);

async function main() {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const cfg = CHAINS[chainId];
  if (!cfg) throw new Error(`Unsupported chainId ${chainId}`);
  const diamond = process.env[cfg.env];
  if (!diamond) throw new Error(`Set ${cfg.env} in .env`);

  const signers = await ethers.getSigners();
  if (signers.length === 0) throw new Error("No signer — is DEPLOYER_PRIVATE_KEY set in .env?");
  const signer = signers[0];

  console.log("\n" + "=".repeat(60));
  console.log(` PREFLIGHT — ${cfg.label} (chainId ${chainId})  [READ-ONLY]`);
  console.log("=".repeat(60));
  console.log("diamond        :", diamond);

  const bal = await ethers.provider.getBalance(signer.address);
  console.log("deployer       :", signer.address);
  console.log("gas balance    :", ethers.formatEther(bal), "(native)");
  if (bal === 0n) console.log("  ⚠️  ZERO gas — top up before upgrading.");

  const ownerHex = await ethers.provider.getStorage(diamond, OWNER_SLOT);
  const owner = ethers.getAddress("0x" + ownerHex.slice(-40));
  const isOwner = owner.toLowerCase() === signer.address.toLowerCase();
  console.log("diamond owner  :", owner, isOwner ? "✓ deployer IS owner (can cut)" : "✗ deployer is NOT owner — cut will revert");

  const loupe = new ethers.Contract(diamond, LOUPE_ABI, ethers.provider);
  const execFacet = await loupe.facetAddress(EXEC_SEL);
  const timelocked = execFacet !== ethers.ZeroAddress;
  console.log("timelock       :", timelocked ? `INSTALLED (${execFacet}) — direct cut becomes a PROPOSAL` : "not installed — cuts apply immediately");

  const hedge = new ethers.Contract(diamond, ABI, ethers.provider);
  // Sanity: confirm the Hedge facet responds.
  await hedge.getPricingEngineSigner();

  const total = Number(await hedge.getTotalHedgeEvents());
  console.log("\ntotal events   :", total);

  let open = 0, openWithPositions = 0, totalOpenPositions = 0;
  const affected = [];
  for (let id = 1; id <= total; id++) {
    let core;
    try { core = await hedge.getHedgeEventCore(id); } catch { continue; }
    if (Number(core.status) !== 0) continue; // 0 = Open
    open++;
    const posIds = await hedge.getEventPositionIds(id);
    if (posIds.length > 0) {
      openWithPositions++;
      totalOpenPositions += posIds.length;
      const stats = await hedge.getHedgeEventStats(id);
      affected.push({
        id, name: core.name, underlying: core.underlying,
        expiry: new Date(Number(core.expiryDate) * 1000).toISOString(),
        positions: posIds.length, hedgers: Number(stats.hedgerCount),
      });
    }
  }

  console.log("OPEN events    :", open);
  console.log("OPEN w/ positions (rules WILL change):", openWithPositions, `(${totalOpenPositions} positions)`);
  if (affected.length > 0) {
    console.log("\n  ⚠️  These live events have active hedger positions bought under the OLD");
    console.log("      (one-touch) rule. The European upgrade changes their settlement:");
    for (const a of affected) {
      console.log(`      #${a.id} ${a.underlying} "${a.name}" — ${a.positions} positions, expiry ${a.expiry}`);
    }
    console.log("\n  Consider letting these expire/settle before upgrading, or accept the change.");
  } else {
    console.log("\n  ✓ No live positions affected — safe window for the behaviour change.");
  }

  console.log("\nPreflight only. No transaction was sent.");
}

main().catch((e) => { console.error("\nPreflight failed:", e.message || e); process.exitCode = 1; });
