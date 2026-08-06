/**
 * upgrade-hedge-premium-fee.js — deploys the HedgeFacet that charges the
 * platform fee on the PREMIUM rather than the notional, and cuts it in.
 *
 * Scope is deliberately narrow:
 *   - HedgeFacet only. OracleFacet on Base is byte-identical to HEAD, so
 *     redeploying it would burn gas replacing it with itself.
 *   - Replace only. All 48 HEAD selectors are already routed to the live
 *     HedgeFacet (verified against the Loupe), so there is nothing to Add
 *     and nothing to Remove. No interface change, no storage change.
 *
 * After the cut it resets hedgerFeeRate. This matters: the live value is 500
 * (0.05%), chosen so that a NOTIONAL-based fee happened to equal 5% of premium
 * on a 1%-premium pool. Once the fee is charged on premium, 500 would mean
 * 0.05% OF PREMIUM — 100x too low. The correct value under the new formula is
 * 50000 (5% of premium), which is what the old workaround was approximating.
 *
 * Public Base RPCs throttle hard and ethers surfaces the throttle as a revert,
 * so every read is retried rather than trusted first time.
 *
 * Usage: npx hardhat run scripts/upgrade-hedge-premium-fee.js --network base
 */

const hre = require("hardhat");
const { ethers } = hre;

const DIAMOND = process.env.BASE_DIAMOND_ADDRESS || "0xbCC51E62C4948FD35ab505bd71804C849601e4Ef";

// Target fee config after the upgrade. Only hedgerFeeRate changes meaning.
const CREATION_FEE   = 25_000_000n; // $25 USDC, unchanged
const HEDGER_FEE     = 50_000n;     // 5% — now OF PREMIUM
const PAYOUT_FEE     = 20_000n;     // 2%, unchanged
const LP_PROFIT_FEE  = 20_000n;     // 2%, unchanged
const CREATOR_LOYAL  = 50_000n;     // 5%, unchanged

async function retry(fn, label, tries = 8) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error(`${label} failed after ${tries} attempts: ${lastErr?.shortMessage || lastErr?.message}`);
}

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("deployer :", deployer.address);
  console.log("diamond  :", DIAMOND);

  const feeAbi = ["function getHedgeFeeConfig() view returns (uint256,uint256,uint256,uint256,uint256)",
                  "function initializeHedgeFees(uint256,uint256,uint256,uint256,uint256)"];
  const fees = new ethers.Contract(DIAMOND, feeAbi, deployer);

  const before = await retry(() => fees.getHedgeFeeConfig(), "read fee config");
  console.log("fee cfg before:", [0,1,2,3,4].map(i => before[i].toString()).join(" | "));

  // 1. Deploy the new facet
  console.log("\n[1/4] deploying BlockFinaXHedgeFacet ...");
  const Factory = await ethers.getContractFactory("BlockFinaXHedgeFacet");
  const facet = await Factory.deploy();
  await facet.waitForDeployment();
  const facetAddr = await facet.getAddress();
  console.log("      new facet:", facetAddr);

  // 2. Build the Replace cut. Assert every selector is already routed, so a
  //    mistake here surfaces before the cut rather than as a bricked selector.
  const iface = facet.interface;
  const selectors = iface.fragments
    .filter((f) => f.type === "function")
    .map((f) => iface.getFunction(f.name).selector);

  const loupe = new ethers.Contract(DIAMOND, ["function facetAddress(bytes4) view returns (address)"], deployer);
  const notRouted = [];
  for (const sel of selectors) {
    const cur = await retry(() => loupe.facetAddress(sel), `loupe ${sel}`);
    if (cur === ethers.ZeroAddress) notRouted.push(sel);
  }
  if (notRouted.length) {
    throw new Error(`Refusing to cut: ${notRouted.length} selector(s) are not currently routed, ` +
                    `so this is not a pure Replace: ${notRouted.join(", ")}`);
  }
  console.log(`[2/4] verified ${selectors.length} selectors are all Replace (0 Add, 0 Remove)`);

  // 3. Cut
  const cut = new ethers.Contract(
    DIAMOND,
    ["function diamondCut((address facetAddress,uint8 action,bytes4[] functionSelectors)[] _diamondCut, address _init, bytes _calldata)"],
    deployer
  );
  console.log("[3/4] submitting diamondCut ...");
  const cutTx = await cut.diamondCut([[facetAddr, 1 /* Replace */, selectors]], ethers.ZeroAddress, "0x");
  console.log("      tx:", cutTx.hash);
  const cutRc = await cutTx.wait();
  console.log("      status:", cutRc.status === 1 ? "SUCCESS" : "FAILED", "| block", cutRc.blockNumber);
  if (cutRc.status !== 1) throw new Error("diamondCut reverted — aborting before fee change");

  // 4. Reset the rate to mean 5% of premium
  console.log("[4/4] setting hedgerFeeRate to 50000 (5% of premium) ...");
  const feeTx = await fees.initializeHedgeFees(CREATION_FEE, HEDGER_FEE, PAYOUT_FEE, LP_PROFIT_FEE, CREATOR_LOYAL);
  console.log("      tx:", feeTx.hash);
  const feeRc = await feeTx.wait();
  console.log("      status:", feeRc.status === 1 ? "SUCCESS" : "FAILED");

  const after = await retry(() => fees.getHedgeFeeConfig(), "read fee config after");
  console.log("\nfee cfg after :", [0,1,2,3,4].map(i => after[i].toString()).join(" | "));
  console.log("cut tx  :", `https://basescan.org/tx/${cutTx.hash}`);
  console.log("fee tx  :", `https://basescan.org/tx/${feeTx.hash}`);
  console.log("facet   :", `https://basescan.org/address/${facetAddr}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
