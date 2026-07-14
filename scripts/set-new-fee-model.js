/**
 * set-new-fee-model.js — set the production fee schedule via initializeHedgeFees (owner only).
 *
 *   creation fee : $25   (F-09)
 *   hedger fee   : 5% of the PREMIUM   (F-10 — base changed to premium in the facet)
 *   payout fee   : 2% of the payout
 *   LP fee       : 2% of premiums claimed
 *   creator loyalty: 5% of every platform fee (unchanged)
 *
 * Only affects NEW events (rates are snapshotted per-event at createEvent).
 *
 *   npx hardhat run scripts/set-new-fee-model.js --network base
 *   npx hardhat run scripts/set-new-fee-model.js --network bsc
 */
const hre = require("hardhat");
const { ethers } = hre;

// creation fee is denominated in the chain's payment-token decimals (USDC 6 / USDT 18).
const CHAINS = {
  8453: { env: "BASE_DIAMOND_ADDRESS", creationFee: 25n * 10n ** 6n },   // Base, USDC 6-dec
  56:   { env: "BSC_DIAMOND_ADDRESS",  creationFee: 25n * 10n ** 18n },  // BSC, USDT 18-dec
};
const HEDGER_FEE = 50_000n;   // 5%
const PAYOUT_FEE = 20_000n;   // 2%
const LP_FEE     = 20_000n;   // 2%
const LOYALTY    = 50_000n;   // 5%

const ABI = [
  "function initializeHedgeFees(uint256,uint256,uint256,uint256,uint256) external",
  "function getHedgeFeeConfig() view returns (uint256,uint256,uint256,uint256,uint256)",
];

async function main() {
  const net = await ethers.provider.getNetwork();
  const cfg = CHAINS[Number(net.chainId)];
  if (!cfg) throw new Error(`Unsupported chainId ${net.chainId}`);
  const diamond = process.env[cfg.env];
  if (!diamond) throw new Error(`Set ${cfg.env}`);

  const [signer] = await ethers.getSigners();
  const d = new ethers.Contract(diamond, ABI, signer);

  const before = await d.getHedgeFeeConfig();
  console.log("network :", hre.network.name);
  console.log("diamond :", diamond);
  console.log("signer  :", signer.address);
  console.log("before  :", before.map(b => b.toString()));
  console.log("setting :", [cfg.creationFee, HEDGER_FEE, PAYOUT_FEE, LP_FEE, LOYALTY].map(b => b.toString()));

  const tx = await d.initializeHedgeFees(cfg.creationFee, HEDGER_FEE, PAYOUT_FEE, LP_FEE, LOYALTY);
  console.log("tx      :", tx.hash);
  const r = await tx.wait();
  console.log("confirmed in block", r.blockNumber);

  const after = await d.getHedgeFeeConfig();
  console.log("after   :", after.map(b => b.toString()));
  const ok = after[1] === HEDGER_FEE && after[2] === PAYOUT_FEE && after[3] === LP_FEE && after[4] === LOYALTY && after[0] === cfg.creationFee;
  console.log(ok ? "\n✓ fee model set correctly" : "\n✗ MISMATCH — check values");
}

main().catch(e => { console.error("Failed:", e.message || e); process.exitCode = 1; });
