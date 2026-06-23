/**
 * revenue-report.js — READ-ONLY snapshot of events + protocol revenue across all chains.
 * Broadcasts nothing. Run with plain node (uses public RPCs):
 *   node scripts/revenue-report.js
 *
 * "Protocol revenue" = platform fees only (creation + hedger + payout + LP-profit fees,
 * net of the creator-loyalty share). It does NOT include premiums (those belong to LPs)
 * or creator earnings (those belong to event creators).
 *
 * platformFeesByToken = fees CURRENTLY accrued and not yet withdrawn. Lifetime earned =
 * that + everything already withdrawn (summed from withdrawal events, best-effort).
 */

const { ethers } = require("ethers");

const CHAINS = [
  {
    label: "Base", rpc: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    diamond: "0xbCC51E62C4948FD35ab505bd71804C849601e4Ef",
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", sym: "USDC", dec: 6,
  },
  {
    label: "BSC", rpc: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
    diamond: "0xaC939C0897981Abc0711ec4e37527F13106180fc",
    token: "0x55d398326f99059fF775485246999027B3197955", sym: "USDT", dec: 18,
  },
];

const ABI = [
  "function getTotalHedgeEvents() view returns (uint256)",
  "function getHedgeEventCore(uint256) view returns (uint256 id,address creator,string name,string underlying,uint256 strike,uint256 premiumRate,uint256 expiryDate,uint8 status,bool poolOpen,bool allowExternalLp,uint256 initialRate,bool strikeAbove)",
  "function getHedgeEventStats(uint256) view returns (uint256 settlementPrice,bool triggered,uint256 settledAt,uint256 creatorEarnings,uint256 totalLiquidity,uint256 totalExposure,uint256 totalPremiums,uint256 lpCount,uint256 hedgerCount,uint256 totalMaxPayout)",
  "function getHedgePlatformFees() view returns (uint256)",
  "function getPlatformFeesByToken(address) view returns (uint256)",
  "event PlatformFeesWithdrawn(address indexed admin, uint256 amount)",
  "event PlatformFeesByTokenWithdrawn(address indexed token, address indexed admin, uint256 amount)",
];

const STATUS = ["Open", "Settled", "Expired"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Throttled call with backoff on public-RPC rate limits (-32016 / "over rate limit").
async function rl(fn, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const out = await fn();
      await sleep(200);
      return out;
    } catch (e) {
      const msg = (e && (e.info?.error?.message || e.shortMessage || e.message)) || "";
      const rate = e?.info?.error?.code === -32016 || /rate limit/i.test(msg);
      if (rate && i < tries - 1) { await sleep(800 * (i + 1)); continue; }
      throw e;
    }
  }
}

async function sumWithdrawn(diamondC, token) {
  // Best-effort: public RPCs may reject a full-history getLogs. Returns null on failure.
  try {
    const f1 = await diamondC.queryFilter(diamondC.filters.PlatformFeesWithdrawn(), 0, "latest");
    const f2 = await diamondC.queryFilter(diamondC.filters.PlatformFeesByTokenWithdrawn(token), 0, "latest");
    let total = 0n;
    for (const e of f1) total += e.args.amount;            // legacy USDC path
    for (const e of f2) total += e.args.amount;            // per-token path
    return total;
  } catch {
    return null;
  }
}

(async () => {
  let grandLine = [];
  for (const c of CHAINS) {
    console.log("\n" + "=".repeat(62));
    console.log(` ${c.label}  —  diamond ${c.diamond}`);
    console.log("=".repeat(62));
    const p = new ethers.JsonRpcProvider(c.rpc);
    const d = new ethers.Contract(c.diamond, ABI, p);

    const total = Number(await rl(() => d.getTotalHedgeEvents()));
    const counts = { Open: 0, Settled: 0, Expired: 0 };
    let premiums = 0n, liquidity = 0n, exposure = 0n, hedgers = 0;

    for (let id = 1; id <= total; id++) {
      let core, stats;
      try { core = await rl(() => d.getHedgeEventCore(id)); stats = await rl(() => d.getHedgeEventStats(id)); } catch { continue; }
      counts[STATUS[Number(core.status)]]++;
      premiums  += stats.totalPremiums;
      liquidity += stats.totalLiquidity;
      exposure  += stats.totalExposure;
      hedgers   += Number(stats.hedgerCount);
      console.log(`  #${id} ${core.underlying.padEnd(9)} ${STATUS[Number(core.status)].padEnd(8)} ` +
        `liq=${ethers.formatUnits(stats.totalLiquidity, c.dec)} prem=${ethers.formatUnits(stats.totalPremiums, c.dec)} ` +
        `hedgers=${stats.hedgerCount}`);
    }

    const accrued = await rl(() => d.getPlatformFeesByToken(c.token));
    const withdrawn = await sumWithdrawn(d, c.token);
    const lifetime = withdrawn === null ? null : accrued + withdrawn;

    console.log("\n  Events:        total " + total +
      `  (Open ${counts.Open}, Settled ${counts.Settled}, Expired ${counts.Expired})`);
    console.log("  Total premiums (LP income):   " + ethers.formatUnits(premiums, c.dec) + " " + c.sym);
    console.log("  Total liquidity ever pooled:  " + ethers.formatUnits(liquidity, c.dec) + " " + c.sym);
    console.log("  ── PROTOCOL REVENUE (platform fees) ──");
    console.log("  Accrued, withdrawable now:    " + ethers.formatUnits(accrued, c.dec) + " " + c.sym);
    if (lifetime === null) {
      console.log("  Already withdrawn:            (could not read logs on this RPC)");
    } else {
      console.log("  Already withdrawn:            " + ethers.formatUnits(withdrawn, c.dec) + " " + c.sym);
      console.log("  Lifetime earned:              " + ethers.formatUnits(lifetime, c.dec) + " " + c.sym);
    }
    grandLine.push(`${c.label}: open ${counts.Open}/${total} events · accrued fees ${ethers.formatUnits(accrued, c.dec)} ${c.sym}` +
      (lifetime === null ? "" : ` · lifetime ${ethers.formatUnits(lifetime, c.dec)} ${c.sym}`));
  }

  console.log("\n" + "=".repeat(62));
  console.log(" SUMMARY");
  console.log("=".repeat(62));
  for (const l of grandLine) console.log("  " + l);
  console.log("\n  (Revenue = platform fees only; premiums go to LPs, loyalty to creators.)");
})();
