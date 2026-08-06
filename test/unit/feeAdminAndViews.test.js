/**
 * feeAdminAndViews.test.js — initializeHedgeFees caps + the remaining read-only views and
 * counters not exercised elsewhere (getPoolUtilization, getHedgeFeeConfig, getHedgePlatformFees,
 * getHedgerPositionIds, getLpDepositIds, getTotalHedgeEvents, isPaused, isFeesInitialized,
 * getEventPaymentToken, withdrawPlatformFeesByToken amount-zero guard).
 */

const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
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
const PRECISION = 10n ** 6n;

describe("HedgeFacet.initializeHedgeFees — caps & access", function () {
  it("only owner can initialise/update fees", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.stranger).initializeHedgeFees(0n, 0n, 0n, 0n, 0n))
      .to.be.revertedWith("Not owner");
  });

  it("rejects a creation fee above the $1000 (×1e18) cap", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const overCap = 1_000n * 10n ** 18n + 1n;
    await expect(hedge.connect(signers.owner).initializeHedgeFees(overCap, 0n, 0n, 0n, 0n))
      .to.be.revertedWith("Creation fee exceeds $1000 cap");
  });

  it("rejects hedgerFeeRate above the 10% cap", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.owner).initializeHedgeFees(0n, 100_001n, 0n, 0n, 0n))
      .to.be.revertedWith("hedgerFeeRate exceeds 10% cap");
  });

  it("rejects hedgerPayoutFeeRate above the 10% cap", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.owner).initializeHedgeFees(0n, 0n, 100_001n, 0n, 0n))
      .to.be.revertedWith("hedgerPayoutFeeRate exceeds 10% cap");
  });

  it("rejects lpProfitFeeRate above the 10% cap", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.owner).initializeHedgeFees(0n, 0n, 0n, 100_001n, 0n))
      .to.be.revertedWith("lpProfitFeeRate exceeds 10% cap");
  });

  it("rejects creatorLoyaltyRate above the 50% cap", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.owner).initializeHedgeFees(0n, 0n, 0n, 0n, 500_001n))
      .to.be.revertedWith("creatorLoyaltyRate exceeds 50% cap");
  });

  it("accepts values exactly at the caps and emits FeesInitialized", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.owner).initializeHedgeFees(
      1_000n * 10n ** 18n, 100_000n, 100_000n, 100_000n, 500_000n
    )).to.emit(hedge, "FeesInitialized")
      .withArgs(1_000n * 10n ** 18n, 100_000n, 100_000n, 100_000n, 500_000n);

    const cfg = await hedge.getHedgeFeeConfig();
    expect(cfg.eventCreationFee).to.equal(1_000n * 10n ** 18n);
    expect(cfg.hedgerFeeRate).to.equal(100_000n);
    expect(cfg.creatorLoyaltyRate).to.equal(500_000n);
  });
});

describe("HedgeFacet — protocol-state views", function () {
  it("isFeesInitialized true after fixture init; isPaused reflects pause state", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    expect(await hedge.isFeesInitialized()).to.equal(true);
    expect(await hedge.isPaused()).to.equal(false);
    await hedge.connect(signers.owner).pause();
    expect(await hedge.isPaused()).to.equal(true);
  });

  it("getTotalHedgeEvents increments per createEvent", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    expect(await hedge.getTotalHedgeEvents()).to.equal(0n);
    await hedge.connect(signers.creator).createEvent(buildEventParams());
    await hedge.connect(signers.creator).createEvent(buildEventParams());
    expect(await hedge.getTotalHedgeEvents()).to.equal(2n);
  });

  it("getHedgeFeeConfig returns the fixture's default schedule", async function () {
    const { hedge, constants } = await loadFixture(deployDiamondFixture);
    const cfg = await hedge.getHedgeFeeConfig();
    expect(cfg.eventCreationFee).to.equal(constants.DEFAULT_FEES.eventCreationFee);
    expect(cfg.hedgerFeeRate).to.equal(constants.DEFAULT_FEES.hedgerFeeRate);
    expect(cfg.hedgerPayoutFeeRate).to.equal(constants.DEFAULT_FEES.hedgerPayoutFeeRate);
    expect(cfg.lpProfitFeeRate).to.equal(constants.DEFAULT_FEES.lpProfitFeeRate);
    expect(cfg.creatorLoyaltyRate).to.equal(constants.DEFAULT_FEES.creatorLoyaltyRate);
  });

  it("getHedgePlatformFees grows by the creation fee + net hedger fee after a buy", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await hedge.connect(signers.creator).createEvent(buildEventParams());
    const eventId = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.creator, eventId);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    // $25 creation fee + (hedger fee − creator loyalty).
    // Fee is now 0.5% of the $25 premium = $0.125; creator loyalty is 5% of that
    // = $0.00625, so the platform keeps $0.11875. Total $25.11875.
    expect(await hedge.getHedgePlatformFees()).to.equal(25n * ONE_USDC + 118_750n);
  });

  it("getEventPaymentToken reverts for unknown event, returns USDC for default events", async function () {
    const { hedge, signers, addresses } = await loadFixture(deployDiamondFixture);
    await expect(hedge.getEventPaymentToken(999n)).to.be.revertedWith("Event not found");
    await hedge.connect(signers.creator).createEvent(buildEventParams());
    expect(await hedge.getEventPaymentToken(await hedge.getTotalHedgeEvents())).to.equal(addresses.usdc);
  });
});

describe("HedgeFacet — per-account index views", function () {
  it("getHedgerPositionIds and getLpDepositIds track each account's records", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await hedge.connect(signers.creator).createEvent(buildEventParams({ initialLiquidity: 10_000n * ONE_USDC }));
    const eventId = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.creator, eventId);

    await hedge.connect(signers.lp1).deposit(eventId, 1_000n * ONE_USDC);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 500n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    const hedgerPositions = await hedge.getHedgerPositionIds(signers.hedger1.address);
    expect(hedgerPositions.length).to.equal(2);

    const lpDeposits = await hedge.getLpDepositIds(signers.lp1.address);
    expect(lpDeposits.length).to.equal(1);

    // Creator has the initial deposit only.
    expect((await hedge.getLpDepositIds(signers.creator.address)).length).to.equal(1);
  });
});

describe("HedgeFacet.getPoolUtilization", function () {
  it("reports liquidity, exposure, available capacity and utilisation%", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    // $10K pool. One $1K position → $100 reserved (range width 1 / initialRate 10).
    await hedge.connect(signers.creator).createEvent(buildEventParams({ initialLiquidity: 10_000n * ONE_USDC }));
    const eventId = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.creator, eventId);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    const u = await hedge.getPoolUtilization(eventId);
    expect(u.totalLiquidity).to.equal(10_000n * ONE_USDC);
    expect(u.totalExposure).to.equal(1_000n * ONE_USDC);
    expect(u.availableCapacity).to.equal(10_000n * ONE_USDC - 100n * ONE_USDC); // $9,900 free
    // utilisation = totalMaxPayout × 100 × PRECISION / totalLiquidity
    //             = 100e6 × 100 × 1e6 / 10_000e6 = 1e9  (i.e. 1%)
    expect(u.utilizationPercent).to.equal((100n * ONE_USDC * 100n * PRECISION) / (10_000n * ONE_USDC));
  });

  it("returns zero utilisation for a fresh pool with no positions", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await hedge.connect(signers.creator).createEvent(buildEventParams());
    const eventId = await hedge.getTotalHedgeEvents();
    const u = await hedge.getPoolUtilization(eventId);
    expect(u.utilizationPercent).to.equal(0n);
    expect(u.availableCapacity).to.equal(10_000n * ONE_USDC);
  });
});

describe("HedgeFacet.withdrawPlatformFeesByToken — amount guard", function () {
  it("rejects a zero-amount withdrawal", async function () {
    const { hedge, signers, addresses } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.owner).withdrawPlatformFeesByToken(addresses.usdc, 0n))
      .to.be.revertedWith("Amount must be > 0");
  });
});
