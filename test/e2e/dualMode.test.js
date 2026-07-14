/**
 * dualMode.test.js — proves a single-strike (legacy) event and a v7 range event coexist
 * in the same Diamond without interfering with each other.
 *
 * Two events are created in parallel by different creators with different shapes:
 *   Event 1 (single-strike): payoutCap = 0; payout is digital — full $100 if rate ≥ 11
 *   Event 2 (range):         payoutCap = 12; payout scales linearly inside [11, 12]
 *
 * Both are settled with settlementPrice = 11.5 (which would mid-range Event 2 for a
 * partial $50 payout, but which fully triggers Event 1 for the digital $100).
 *
 * Test asserts:
 *   - Both events created without conflict
 *   - LPs in event 1 absorb $100 loss; LPs in event 2 absorb $50 loss
 *   - Hedger payouts differ ($100 digital vs $50 mid-range) for the SAME settlement price
 *   - Pool accounting per event is independent (one event's settlement doesn't move the other)
 *   - getHedgeEventRange correctly distinguishes payoutCap = 0 vs > 0
 *   - quoteRangePayout returns digital payout for legacy event, ramped payout for range event
 */

const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");
const {
  deployDiamondFixture,
  buildEventParams,
  openPool,
  warpPastExpiry,
  rate,
  ONE_USDC,
} = require("../helpers/fixtures");

const MAX_UINT = ethers.MaxUint256;
const FAR_FUTURE = MAX_UINT;

describe("E2E: dual-mode coexistence — single-strike + range in same Diamond", function () {

  it("creates both event shapes; getHedgeEventRange distinguishes them", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);

    // Event 1 — single-strike (digital). payoutCap = 0.
    await hedge.connect(signers.creator).createEvent(buildEventParams({
      payoutCap: 0n,
      name: "Digital event",
    }));
    const event1 = await hedge.getTotalHedgeEvents();

    // Event 2 — range product. payoutCap = 12.
    await hedge.connect(signers.creator).createEvent(buildEventParams({
      payoutCap: rate(12),
      name: "Range event",
    }));
    const event2 = await hedge.getTotalHedgeEvents();

    expect(event2 - event1).to.equal(1n);

    const r1 = await hedge.getHedgeEventRange(event1);
    const r2 = await hedge.getHedgeEventRange(event2);
    expect(r1.payoutCap).to.equal(0n);
    expect(r2.payoutCap).to.equal(rate(12));
  });

  it("settles both at the same price; payouts reflect each event's shape", async function () {
    const { hedge, signers, usdc } = await loadFixture(deployDiamondFixture);

    // Event 1 — digital, creator + LP both deposit $5K each.
    await hedge.connect(signers.creator).createEvent(buildEventParams({
      payoutCap: 0n,
      initialLiquidity: 5_000n * ONE_USDC,
    }));
    const event1 = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.creator, event1);
    await hedge.connect(signers.lp1).deposit(event1, 5_000n * ONE_USDC);
    await hedge.connect(signers.hedger1).buyProtection(event1, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    // Event 2 — range, creator + LP2 each $5K.
    await hedge.connect(signers.creator).createEvent(buildEventParams({
      payoutCap: rate(12),
      initialLiquidity: 5_000n * ONE_USDC,
    }));
    const event2 = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.creator, event2);
    await hedge.connect(signers.lp2).deposit(event2, 5_000n * ONE_USDC);
    await hedge.connect(signers.hedger2).buyProtection(event2, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    // Both settle at 11.5 (European: only possible at/after expiry).
    await warpPastExpiry(hedge, event2);
    await hedge.connect(signers.oracleAdmin).settleEvent(event1, rate(11.5));
    await hedge.connect(signers.oracleAdmin).settleEvent(event2, rate(11.5));

    // Hedger payouts differ for the SAME settlement price.
    const pos1 = await hedge.getHedgePosition((await hedge.getEventPositionIds(event1))[0]);
    const pos2 = await hedge.getHedgePosition((await hedge.getEventPositionIds(event2))[0]);
    expect(pos1.payoutAmount).to.equal(100n * ONE_USDC); // digital → full $100
    expect(pos2.payoutAmount).to.equal( 50n * ONE_USDC); // range mid → $50

    // Per-event totalMaxPayout reflects the actual aggregate loss for each shape.
    const stats1 = await hedge.getHedgeEventStats(event1);
    const stats2 = await hedge.getHedgeEventStats(event2);
    expect(stats1.totalMaxPayout).to.equal(100n * ONE_USDC);
    expect(stats2.totalMaxPayout).to.equal( 50n * ONE_USDC);

    // Hedgers claim and confirm correct net payout.
    const balH1Before = await usdc.balanceOf(signers.hedger1.address);
    const balH2Before = await usdc.balanceOf(signers.hedger2.address);
    await hedge.connect(signers.hedger1).claimPayout(pos1.id);
    await hedge.connect(signers.hedger2).claimPayout(pos2.id);
    expect(await usdc.balanceOf(signers.hedger1.address) - balH1Before).to.equal(98n * ONE_USDC);  // $100 - 2%
    expect(await usdc.balanceOf(signers.hedger2.address) - balH2Before).to.equal( 49n * ONE_USDC); // $50 - 2%
  });

  it("LPs in each event absorb only their own event's loss (events are isolated)", async function () {
    const { hedge, signers, usdc } = await loadFixture(deployDiamondFixture);

    // Event 1 — digital. Just creator $10K to keep math simple.
    await hedge.connect(signers.creator).createEvent(buildEventParams({
      payoutCap: 0n,
      initialLiquidity: 10_000n * ONE_USDC,
    }));
    const event1 = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.creator, event1);
    await hedge.connect(signers.hedger1).buyProtection(event1, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    // Event 2 — range, lp1 only $10K.
    await hedge.connect(signers.lp1).createEvent(buildEventParams({
      payoutCap: rate(12),
      initialLiquidity: 10_000n * ONE_USDC,
    }));
    const event2 = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.lp1, event2);
    await hedge.connect(signers.hedger2).buyProtection(event2, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    // Both settle at 11.5 (European: only possible at/after expiry).
    await warpPastExpiry(hedge, event2);
    await hedge.connect(signers.oracleAdmin).settleEvent(event1, rate(11.5));
    await hedge.connect(signers.oracleAdmin).settleEvent(event2, rate(11.5));
    await hedge.connect(signers.hedger1).claimPayout((await hedge.getEventPositionIds(event1))[0]);
    await hedge.connect(signers.hedger2).claimPayout((await hedge.getEventPositionIds(event2))[0]);

    const creatorDepId = (await hedge.getLpDepositIds(signers.creator.address))[0];
    const lp1DepId     = (await hedge.getLpDepositIds(signers.lp1.address))[0];

    // Capture pre-withdraw balances.
    const c0 = await usdc.balanceOf(signers.creator.address);
    const l0 = await usdc.balanceOf(signers.lp1.address);

    await hedge.connect(signers.creator).claimPremiums(creatorDepId);
    await hedge.connect(signers.lp1).claimPremiums(lp1DepId);
    await hedge.connect(signers.creator).withdrawCapital(creatorDepId);
    await hedge.connect(signers.lp1).withdrawCapital(lp1DepId);

    const c1 = await usdc.balanceOf(signers.creator.address);
    const l1 = await usdc.balanceOf(signers.lp1.address);

    // Creator (sole LP for digital event):
    //   capital: $10K - $100 loss = $9,900
    //   premium: $25 - 2% fee ($0.50) = $24.50
    //   total received: $9,924.50
    expect(c1 - c0).to.equal(9_924_500_000n);

    // LP1 (sole LP for range event):
    //   capital: $10K - $50 loss = $9,950
    //   premium: $25 - 2% fee ($0.50) = $24.50
    //   total received: $9,974.50
    expect(l1 - l0).to.equal(9_974_500_000n);

    // The two amounts differ by exactly $50 — the difference between the digital
    // payoff ($100) and the mid-range payoff ($50) at settlement = 11.5. The events
    // don't bleed into each other.
    expect((l1 - l0) - (c1 - c0)).to.equal(50n * ONE_USDC);
  });

  it("quoteRangePayout returns the right shape per event mode", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);

    await hedge.connect(signers.creator).createEvent(buildEventParams({ payoutCap: 0n }));
    const eventDigital = await hedge.getTotalHedgeEvents();
    await hedge.connect(signers.creator).createEvent(buildEventParams({ payoutCap: rate(12) }));
    const eventRange = await hedge.getTotalHedgeEvents();

    const notional = 1_000n * ONE_USDC;

    // Below strike: both return zero.
    expect(await hedge.quoteRangePayout(eventDigital, rate(10.5), notional)).to.equal(0n);
    expect(await hedge.quoteRangePayout(eventRange,   rate(10.5), notional)).to.equal(0n);

    // Mid-range settlement (11.5):
    expect(await hedge.quoteRangePayout(eventDigital, rate(11.5), notional)).to.equal(100n * ONE_USDC); // digital all-or-nothing
    expect(await hedge.quoteRangePayout(eventRange,   rate(11.5), notional)).to.equal( 50n * ONE_USDC); // ramp midpoint

    // Above cap settlement (13):
    expect(await hedge.quoteRangePayout(eventDigital, rate(13), notional)).to.equal(100n * ONE_USDC);   // unchanged, digital
    expect(await hedge.quoteRangePayout(eventRange,   rate(13), notional)).to.equal(100n * ONE_USDC);   // capped

    // Way above: same.
    expect(await hedge.quoteRangePayout(eventDigital, rate(99), notional)).to.equal(100n * ONE_USDC);
    expect(await hedge.quoteRangePayout(eventRange,   rate(99), notional)).to.equal(100n * ONE_USDC);
  });
});
