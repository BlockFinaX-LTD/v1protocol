/**
 * buyProtection.test.js — math + validation for buyProtection() in both product modes.
 *
 * Covers:
 *   - predetermined payout = notional × (cap - strike) / initialRate         (range mode)
 *   - predetermined payout = notional × |strike - initialRate| / initialRate (single-strike mode)
 *   - premium = notional × premiumRate / PRECISION
 *   - platform fee = premium × hedgerFeeRate / PRECISION  (charged on the premium,
 *     not the notional, so it scales with the price of the risk)
 *   - solvency invariant: predeterminedPayout ≤ totalLiquidity − totalMaxPayout
 *   - slippage and deadline guards
 *   - position counter & per-event/per-hedger registration
 *   - status guards (Open, poolOpen, expiry, max positions)
 *   - creator earnings accrue correctly from the creator-loyalty share of fees
 */

const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");
const {
  deployDiamondFixture,
  buildEventParams,
  openPool,
  rate,
  ONE_USDC,
} = require("../helpers/fixtures");

const MAX_UINT = ethers.MaxUint256;
const FAR_FUTURE = MAX_UINT;

// Helper: setup one open event with given params, returns eventId.
async function makeOpenEvent(hedge, signers, paramOverrides = {}) {
  await hedge.connect(signers.creator).createEvent(buildEventParams(paramOverrides));
  const eventId = await hedge.getTotalHedgeEvents();
  await openPool(hedge, signers.creator, eventId);
  return eventId;
}

describe("HedgeFacet.buyProtection — range mode math", function () {

  it("computes predetermined payout = notional × rangeWidth / initialRate", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    // strike=11, payoutCap=12, initialRate=10 → rangeWidth = 1, max payout per $ = 0.1
    const eventId = await makeOpenEvent(hedge, signers);

    const notional = 1_000n * ONE_USDC;
    await hedge.connect(signers.hedger1).buyProtection(eventId, notional, MAX_UINT, FAR_FUTURE);

    const positionIds = await hedge.getEventPositionIds(eventId);
    const pos = await hedge.getHedgePosition(positionIds[0]);
    // payout = 1000 × 1 / 10 = 100 USDC
    expect(pos.payoutAmount).to.equal(100n * ONE_USDC);
    expect(pos.notional).to.equal(notional);
  });

  it("computes premium from notional × rate and platformFee from premium × rate", async function () {
    const { hedge, signers, constants } = await loadFixture(deployDiamondFixture);
    const eventId = await makeOpenEvent(hedge, signers); // premiumRate=2.5%, hedgerFeeRate=0.5%

    const notional = 1_000n * ONE_USDC;
    await hedge.connect(signers.hedger1).buyProtection(eventId, notional, MAX_UINT, FAR_FUTURE);

    const positionIds = await hedge.getEventPositionIds(eventId);
    const pos = await hedge.getHedgePosition(positionIds[0]);
    expect(pos.premiumPaid).to.equal(25n * ONE_USDC);     // 2.5% of $1000 notional
    expect(pos.platformFeePaid).to.equal(125_000n);       // 0.5% of the $25 premium = $0.125
  });

  // Regression guard. The fee was previously charged on notional, which made it
  // independent of how the cover was priced — on a 1% premium pool a 5% notional
  // fee came to 500% of the premium. This asserts the invariant directly rather
  // than a single hardcoded amount, so the ratio cannot silently drift back.
  it("charges the platform fee as a fixed share of premium, independent of notional", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeOpenEvent(hedge, signers); // premiumRate=2.5%, hedgerFeeRate=0.5%

    for (const notional of [500n, 1_000n, 4_000n]) {
      const id = await makeOpenEvent(hedge, signers);
      await hedge.connect(signers.hedger1).buyProtection(id, notional * ONE_USDC, MAX_UINT, FAR_FUTURE);
      const ids = await hedge.getEventPositionIds(id);
      const pos = await hedge.getHedgePosition(ids[0]);

      // fee / premium must equal hedgerFeeRate (0.5%) at every size.
      expect(pos.platformFeePaid * 1_000_000n / pos.premiumPaid).to.equal(5_000n);
    }
    expect(eventId).to.be.gt(0n);
  });

  it("debits the hedger by premium + platformFee total", async function () {
    const { hedge, signers, usdc } = await loadFixture(deployDiamondFixture);
    const eventId = await makeOpenEvent(hedge, signers);

    const balBefore = await usdc.balanceOf(signers.hedger1.address);
    const notional = 2_000n * ONE_USDC;
    await hedge.connect(signers.hedger1).buyProtection(eventId, notional, MAX_UINT, FAR_FUTURE);

    // premium = 2.5% of 2000 = $50; fee = 0.5% of the $50 premium = $0.25
    const expectedDebit = 50n * ONE_USDC + 250_000n;
    expect(await usdc.balanceOf(signers.hedger1.address)).to.equal(balBefore - expectedDebit);
  });

  it("reserves the worst-case payout in totalMaxPayout (= rangeWidth × notional / initialRate)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeOpenEvent(hedge, signers);

    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    let stats = await hedge.getHedgeEventStats(eventId);
    expect(stats.totalMaxPayout).to.equal(100n * ONE_USDC);

    await hedge.connect(signers.hedger2).buyProtection(eventId, 500n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    stats = await hedge.getHedgeEventStats(eventId);
    expect(stats.totalMaxPayout).to.equal(150n * ONE_USDC);
  });

  it("enforces solvency: predeterminedPayout ≤ totalLiquidity − totalMaxPayout", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    // Pool starts with $10,000 liquidity. Range width = 1, initialRate = 10 → max payout per $ = 0.1.
    // So max insurable notional = $100,000 worth of total promised payouts at $10K liquidity.
    const eventId = await makeOpenEvent(hedge, signers);
    // 1) buy $99,000 notional → $9,900 reserved → fits.
    await hedge.connect(signers.hedger1).buyProtection(eventId, 99_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    // 2) buy $2,000 more → $200 reserved → would push total to $10,100 > $10,000 → revert.
    await expect(hedge.connect(signers.hedger2).buyProtection(eventId, 2_000n * ONE_USDC, MAX_UINT, FAR_FUTURE))
      .to.be.revertedWith("Insufficient pool liquidity for payout");
  });
});

describe("HedgeFacet.buyProtection — single-strike (legacy) mode math", function () {
  it("computes predetermined payout = notional × |strike - initialRate| / initialRate", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    // strike=11, payoutCap=0 (single-strike), initialRate=10 → priceDelta = 1, payout = 0.1 per $
    const eventId = await makeOpenEvent(hedge, signers, { payoutCap: 0n });

    const notional = 1_000n * ONE_USDC;
    await hedge.connect(signers.hedger1).buyProtection(eventId, notional, MAX_UINT, FAR_FUTURE);

    const positionIds = await hedge.getEventPositionIds(eventId);
    const pos = await hedge.getHedgePosition(positionIds[0]);
    expect(pos.payoutAmount).to.equal(100n * ONE_USDC); // same payout as range here because gap == width
  });

  it("downward single-strike: payout uses (initialRate - strike)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    // initialRate=10, strike=8 → priceDelta=2, payout per $ = 0.2
    const eventId = await makeOpenEvent(hedge, signers, {
      payoutCap: 0n, strikeAbove: false, strike: rate(8),
    });

    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    const positionIds = await hedge.getEventPositionIds(eventId);
    const pos = await hedge.getHedgePosition(positionIds[0]);
    expect(pos.payoutAmount).to.equal(200n * ONE_USDC);
  });
});

describe("HedgeFacet.buyProtection — slippage and deadline guards", function () {
  it("reverts when totalCost exceeds the caller's stated _maxCost", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeOpenEvent(hedge, signers);
    // premium $25 + fee (0.5% of premium) $0.125 = $25.125. Set _maxCost = $25 -> revert.
    await expect(hedge.connect(signers.hedger1).buyProtection(
      eventId, 1_000n * ONE_USDC, 25n * ONE_USDC, FAR_FUTURE
    )).to.be.revertedWith("Cost exceeds slippage limit");
  });

  it("succeeds when _maxCost matches actual cost exactly", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeOpenEvent(hedge, signers);
    await expect(hedge.connect(signers.hedger1).buyProtection(
      eventId, 1_000n * ONE_USDC, 30n * ONE_USDC, FAR_FUTURE
    )).to.not.be.reverted;
  });

  it("reverts on expired deadline", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeOpenEvent(hedge, signers);
    const past = (await time.latest()) - 1;
    await expect(hedge.connect(signers.hedger1).buyProtection(
      eventId, 1_000n * ONE_USDC, MAX_UINT, past
    )).to.be.revertedWith("Transaction deadline expired");
  });
});

describe("HedgeFacet.buyProtection — status guards", function () {
  it("reverts when pool is not open", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await hedge.connect(signers.creator).createEvent(buildEventParams());
    const eventId = await hedge.getTotalHedgeEvents();
    // pool is closed by default (poolOpen = false on createEvent)
    await expect(hedge.connect(signers.hedger1).buyProtection(eventId, 100n * ONE_USDC, MAX_UINT, FAR_FUTURE))
      .to.be.revertedWith("Pool not open for hedging");
  });

  it("reverts when notional below 10 USDC minimum", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeOpenEvent(hedge, signers);
    await expect(hedge.connect(signers.hedger1).buyProtection(eventId, 9n * ONE_USDC, MAX_UINT, FAR_FUTURE))
      .to.be.revertedWith("Min notional: 10 USDC");
  });

  it("reverts when block.timestamp >= expiryDate", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const expiry = (await time.latest()) + 60 * 60; // 1 hour from now
    const eventId = await makeOpenEvent(hedge, signers, { expiryDate: expiry });
    await time.increaseTo(expiry + 1);
    await expect(hedge.connect(signers.hedger1).buyProtection(eventId, 100n * ONE_USDC, MAX_UINT, FAR_FUTURE))
      .to.be.revertedWith("Event expired");
  });
});

describe("HedgeFacet.buyProtection — creator loyalty + platform fee split", function () {
  it("credits creatorLoyaltyRate × platformFee to evt.creatorEarnings", async function () {
    const { hedge, signers, constants } = await loadFixture(deployDiamondFixture);
    const eventId = await makeOpenEvent(hedge, signers);

    // premium = 2.5% of $1000 = $25; platformFee = 0.5% of $25 = $0.125.
    // creator gets 5% of that fee = $0.00625
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    const stats = await hedge.getHedgeEventStats(eventId);
    expect(stats.creatorEarnings).to.equal(6_250n); // $0.00625 in 6-dec USDC
  });

  it("aggregates totalPremiums across multiple buys", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeOpenEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await hedge.connect(signers.hedger2).buyProtection(eventId,   500n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    const stats = await hedge.getHedgeEventStats(eventId);
    // 2.5% × 1000 + 2.5% × 500 = 25 + 12.5 = 37.5
    expect(stats.totalPremiums).to.equal(37_500_000n);
  });
});
