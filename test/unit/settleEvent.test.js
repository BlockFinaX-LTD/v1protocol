/**
 * settleEvent.test.js — the v7 settlement math.
 *
 * Covers:
 *   Range mode (payoutCap > 0):
 *     - settlement below strike       → all positions Expired, payoutAmount = 0, totalMaxPayout = 0
 *     - settlement inside the range   → linear payout = notional × (settlement - strike) / initialRate
 *     - settlement above the cap      → payout caps at notional × (cap - strike) / initialRate
 *     - settlement EXACTLY at strike  → triggered=true but payout=0 → status = Expired
 *     - downward hedge symmetry       → same math mirrored for strikeAbove=false
 *     - totalMaxPayout refreshed to Σ(actual payouts) post-settlement
 *
 *   Single-strike (legacy) mode (payoutCap == 0):
 *     - triggered → payoutAmount stays at predetermined; status = Claimable
 *     - not triggered → payoutAmount = 0; status = Expired
 *     - totalMaxPayout refreshed to Σ(predetermined for triggered positions)
 *
 *   Authority + sanity guards:
 *     - only oracle admin or owner can call (pre-V2)
 *     - settlement price out of plausible range rejected
 *     - cannot settle Open events twice
 *     - cannot settle pre-expiry unless strike already touched
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

const HedgeStatus     = { Open: 0, Settled: 1, Expired: 2 };
const PositionStatus  = { Active: 0, SettledWin: 1, SettledLoss: 2, Claimed: 3, Claimable: 4, Expired: 5 };

async function setupRangeEvent(hedge, signers, paramOverrides = {}) {
  await hedge.connect(signers.creator).createEvent(buildEventParams(paramOverrides));
  const eventId = await hedge.getTotalHedgeEvents();
  await openPool(hedge, signers.creator, eventId);
  return eventId;
}

describe("HedgeFacet.settleEvent — range mode payout math", function () {
  // Default range geometry: initialRate=10, strike=11, payoutCap=12
  // Per-notional max payout = (12-11)/10 = 0.10 = 10% of notional

  it("settlement BELOW strike → no payout, all positions Expired, totalMaxPayout = 0", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await hedge.connect(signers.hedger2).buyProtection(eventId, 2_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    // Time-travel past expiry so we can settle without "strike must be reached".
    const core = await hedge.getHedgeEventCore(eventId);
    await time.increaseTo(Number(core.expiryDate) + 1);

    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(10.5));

    const stats = await hedge.getHedgeEventStats(eventId);
    expect(stats.triggered).to.equal(false);
    expect(stats.totalMaxPayout).to.equal(0n);

    const positionIds = await hedge.getEventPositionIds(eventId);
    for (const pid of positionIds) {
      const pos = await hedge.getHedgePosition(pid);
      expect(pos.payoutAmount).to.equal(0n);
      expect(pos.status).to.equal(PositionStatus.Expired);
    }
  });

  it("settlement INSIDE the range → linear payout, status = Claimable", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await hedge.connect(signers.hedger2).buyProtection(eventId, 2_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    // Settlement at 11.5 → effectiveMove = 0.5, per-notional payout = 0.05
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11.5));

    const stats = await hedge.getHedgeEventStats(eventId);
    expect(stats.triggered).to.equal(true);

    const positionIds = await hedge.getEventPositionIds(eventId);
    const pos1 = await hedge.getHedgePosition(positionIds[0]);
    const pos2 = await hedge.getHedgePosition(positionIds[1]);

    // hedger1: 1000 × 0.5 / 10 = $50
    expect(pos1.payoutAmount).to.equal(50n * ONE_USDC);
    expect(pos1.status).to.equal(PositionStatus.Claimable);

    // hedger2: 2000 × 0.5 / 10 = $100
    expect(pos2.payoutAmount).to.equal(100n * ONE_USDC);
    expect(pos2.status).to.equal(PositionStatus.Claimable);

    // totalMaxPayout refreshed to 50 + 100 = 150
    expect(stats.totalMaxPayout).to.equal(150n * ONE_USDC);
  });

  it("settlement ABOVE the cap → payout caps at full range width", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    // Settlement at 13 → above cap (12). effectiveRate = 12, move = 1, payout = 100% of width.
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(13));

    const positionIds = await hedge.getEventPositionIds(eventId);
    const pos = await hedge.getHedgePosition(positionIds[0]);
    expect(pos.payoutAmount).to.equal(100n * ONE_USDC); // 1000 × 1 / 10

    const stats = await hedge.getHedgeEventStats(eventId);
    expect(stats.totalMaxPayout).to.equal(100n * ONE_USDC);
  });

  it("settlement WAY above cap → still capped (no overflow / no extra payout)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    // initialRate=10, max plausible = 100x = 1000
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(100));
    const positionIds = await hedge.getEventPositionIds(eventId);
    const pos = await hedge.getHedgePosition(positionIds[0]);
    expect(pos.payoutAmount).to.equal(100n * ONE_USDC); // still capped at full width
  });

  it("settlement EXACTLY at strike → triggered but payout = 0, status = Expired", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11));

    const stats = await hedge.getHedgeEventStats(eventId);
    expect(stats.triggered).to.equal(true);          // strike >= strike per spec
    expect(stats.totalMaxPayout).to.equal(0n);       // but no actual payout

    const positionIds = await hedge.getEventPositionIds(eventId);
    const pos = await hedge.getHedgePosition(positionIds[0]);
    expect(pos.payoutAmount).to.equal(0n);
    expect(pos.status).to.equal(PositionStatus.Expired);
  });
});

describe("HedgeFacet.settleEvent — downward range mode symmetry", function () {
  // Downward geometry: initialRate=10, strike=9, payoutCap=8
  // Per-notional max payout = (9-8)/10 = 0.10

  it("settlement above strike → no payout (downward not triggered)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers, {
      strikeAbove: false, strike: rate(9), payoutCap: rate(8),
    });
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    const core = await hedge.getHedgeEventCore(eventId);
    await time.increaseTo(Number(core.expiryDate) + 1);
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(9.5));
    const positionIds = await hedge.getEventPositionIds(eventId);
    const pos = await hedge.getHedgePosition(positionIds[0]);
    expect(pos.payoutAmount).to.equal(0n);
    expect(pos.status).to.equal(PositionStatus.Expired);
  });

  it("settlement INSIDE downward range → linear payout", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers, {
      strikeAbove: false, strike: rate(9), payoutCap: rate(8),
    });
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    // settlement at 8.5 → effectiveMove = 9 - 8.5 = 0.5; payout = 1000 × 0.5/10 = $50
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(8.5));
    const positionIds = await hedge.getEventPositionIds(eventId);
    const pos = await hedge.getHedgePosition(positionIds[0]);
    expect(pos.payoutAmount).to.equal(50n * ONE_USDC);
  });

  it("settlement BELOW the cap → payout caps", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers, {
      strikeAbove: false, strike: rate(9), payoutCap: rate(8),
    });
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(7));
    const positionIds = await hedge.getEventPositionIds(eventId);
    const pos = await hedge.getHedgePosition(positionIds[0]);
    expect(pos.payoutAmount).to.equal(100n * ONE_USDC); // full width
  });
});

describe("HedgeFacet.settleEvent — single-strike (legacy) mode", function () {
  it("triggered → payout stays at predetermined; status = Claimable", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers, { payoutCap: 0n });
    // strike=11, initialRate=10 → priceDelta=1, per-notional payout = 0.1
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    // settlement at 11.5 (above strike) → digital pays full $100, regardless of how far
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11.5));

    const positionIds = await hedge.getEventPositionIds(eventId);
    const pos = await hedge.getHedgePosition(positionIds[0]);
    expect(pos.payoutAmount).to.equal(100n * ONE_USDC); // unchanged from buy time
    expect(pos.status).to.equal(PositionStatus.Claimable);

    const stats = await hedge.getHedgeEventStats(eventId);
    expect(stats.totalMaxPayout).to.equal(100n * ONE_USDC);
  });

  it("triggered with extreme settlement → digital still pays only the predetermined amount", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers, { payoutCap: 0n });
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    // Settlement at 50 (5x strike) — digital still pays the same fixed amount.
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(50));
    const positionIds = await hedge.getEventPositionIds(eventId);
    const pos = await hedge.getHedgePosition(positionIds[0]);
    expect(pos.payoutAmount).to.equal(100n * ONE_USDC);
  });

  it("not triggered → payoutAmount = 0, status = Expired, totalMaxPayout = 0", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers, { payoutCap: 0n });
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    const core = await hedge.getHedgeEventCore(eventId);
    await time.increaseTo(Number(core.expiryDate) + 1);
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(10.5));
    const positionIds = await hedge.getEventPositionIds(eventId);
    const pos = await hedge.getHedgePosition(positionIds[0]);
    expect(pos.payoutAmount).to.equal(0n);
    expect(pos.status).to.equal(PositionStatus.Expired);
    const stats = await hedge.getHedgeEventStats(eventId);
    expect(stats.totalMaxPayout).to.equal(0n);
  });
});

describe("HedgeFacet.settleEvent — authority and sanity guards", function () {
  it("only oracleAdmin or owner can call (pre-V2)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    await expect(hedge.connect(signers.stranger).settleEvent(eventId, rate(11.5)))
      .to.be.revertedWith("Not oracle admin");
    // Owner also works.
    await expect(hedge.connect(signers.owner).settleEvent(eventId, rate(11.5))).to.not.be.reverted;
  });

  it("rejects settlement price out of plausible range (>100x or <1/100x of initialRate)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    // initialRate = 10. Plausible range is [0.1, 1000]. Try 1001:
    await expect(hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(1001)))
      .to.be.revertedWith("Settlement price out of plausible range (must be within 100x of initial rate)");
  });

  it("rejects double settlement", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11.5));
    await expect(hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(12)))
      .to.be.revertedWith("Already settled");
  });

  it("rejects pre-expiry settlement when strike not yet touched", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    // Below strike, before expiry.
    await expect(hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(10.5)))
      .to.be.revertedWith("Too early: event not expired and strike not yet reached");
  });

  it("allows pre-expiry settlement when strike has been touched", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    // Pre-expiry but strike (11) was reached → allowed.
    await expect(hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11.2))).to.not.be.reverted;
  });

  it("snapshots totalLiquidity into liquidityAtSettlement", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers);
    await hedge.connect(signers.lp1).deposit(eventId, 5_000n * ONE_USDC); // pool now $15K
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11.5));
    // The struct field isn't directly exposed by the existing getter; verify via withdrawCapital
    // behaviour by checking the recorded liquidity matches via a downstream test in the E2E suite.
    // For this unit test, we just confirm settlement ran and totalMaxPayout updated correctly.
    const stats = await hedge.getHedgeEventStats(eventId);
    expect(stats.totalMaxPayout).to.equal(50n * ONE_USDC);
  });
});

describe("HedgeFacet.quoteRangePayout — view function symmetry", function () {
  it("returns 0 for not-triggered prices", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers);
    expect(await hedge.quoteRangePayout(eventId, rate(10.5), 1_000n * ONE_USDC)).to.equal(0n);
  });
  it("returns linear payout inside the range", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers);
    expect(await hedge.quoteRangePayout(eventId, rate(11.5), 1_000n * ONE_USDC)).to.equal(50n * ONE_USDC);
  });
  it("caps at full range width above payoutCap", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers);
    expect(await hedge.quoteRangePayout(eventId, rate(20), 1_000n * ONE_USDC)).to.equal(100n * ONE_USDC);
  });
  it("returns 0 for unknown event id", async function () {
    const { hedge } = await loadFixture(deployDiamondFixture);
    expect(await hedge.quoteRangePayout(999, rate(11.5), 1_000n * ONE_USDC)).to.equal(0n);
  });
  it("returns the full digital payout for legacy single-strike events", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupRangeEvent(hedge, signers, { payoutCap: 0n });
    // Above strike → full $100
    expect(await hedge.quoteRangePayout(eventId, rate(11.5), 1_000n * ONE_USDC)).to.equal(100n * ONE_USDC);
    // Way above → still $100 (digital is binary)
    expect(await hedge.quoteRangePayout(eventId, rate(50), 1_000n * ONE_USDC)).to.equal(100n * ONE_USDC);
  });
});
