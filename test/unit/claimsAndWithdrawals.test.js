/**
 * claimsAndWithdrawals.test.js — guard branches and happy paths for the four exit functions:
 *   claimPayout, claimPremiums, withdrawCapital, withdrawCreatorEarnings.
 *
 * The masterchef e2e covers the premium-accumulator happy paths; this file focuses on the
 * access-control / lifecycle revert branches and the withdrawCapital loss-share math that
 * the broader e2e flows only touch indirectly.
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
const PositionStatus = { Active: 0, SettledWin: 1, SettledLoss: 2, Claimed: 3, Claimable: 4, Expired: 5 };

// Build an event, open it, buy one position, return ids. Optionally settle.
async function setup(hedge, signers, { settlePrice = null, initialLiquidity = 10_000n * ONE_USDC } = {}) {
  await hedge.connect(signers.creator).createEvent(buildEventParams({ initialLiquidity }));
  const eventId = await hedge.getTotalHedgeEvents();
  await openPool(hedge, signers.creator, eventId);
  await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
  const positionId = (await hedge.getEventPositionIds(eventId))[0];
  if (settlePrice !== null) {
    await warpPastExpiry(hedge, eventId);
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, settlePrice);
  }
  return { eventId, positionId };
}

describe("HedgeFacet.claimPayout — guards & happy path", function () {
  it("reverts for unknown position", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.hedger1).claimPayout(999n))
      .to.be.revertedWith("Position not found");
  });

  it("reverts when caller is not the position owner", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const { positionId } = await setup(hedge, signers, { settlePrice: rate(11.5) });
    await expect(hedge.connect(signers.stranger).claimPayout(positionId))
      .to.be.revertedWith("Not your position");
  });

  it("reverts when the position is not eligible (event not triggered → Expired)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const { positionId } = await setup(hedge, signers, { settlePrice: rate(10.5) }); // below strike
    await expect(hedge.connect(signers.hedger1).claimPayout(positionId))
      .to.be.revertedWith("Not eligible for payout");
  });

  it("reverts on a still-Active position (event not settled yet)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const { positionId } = await setup(hedge, signers); // no settlement
    await expect(hedge.connect(signers.hedger1).claimPayout(positionId))
      .to.be.revertedWith("Not eligible for payout");
  });

  it("pays out net of the payout fee, marks Claimed, and blocks a second claim", async function () {
    const { hedge, signers, usdc } = await loadFixture(deployDiamondFixture);
    const { positionId } = await setup(hedge, signers, { settlePrice: rate(11.5) }); // $50 gross

    const before = await usdc.balanceOf(signers.hedger1.address);
    await expect(hedge.connect(signers.hedger1).claimPayout(positionId))
      .to.emit(hedge, "PayoutClaimed");
    // $50 gross − 2% payout fee = $49.00 net
    expect(await usdc.balanceOf(signers.hedger1.address) - before).to.equal(49n * ONE_USDC);

    const pos = await hedge.getHedgePosition(positionId);
    expect(pos.status).to.equal(PositionStatus.Claimed);
    expect(pos.claimed).to.equal(true);

    await expect(hedge.connect(signers.hedger1).claimPayout(positionId))
      .to.be.revertedWith("Already claimed");
  });

  it("credits the creator-loyalty share of the payout fee to creatorEarnings", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const { eventId, positionId } = await setup(hedge, signers, { settlePrice: rate(11.5) });
    const before = (await hedge.getHedgeEventStats(eventId)).creatorEarnings;
    await hedge.connect(signers.hedger1).claimPayout(positionId);
    const after = (await hedge.getHedgeEventStats(eventId)).creatorEarnings;
    // payoutFee = $50 × 2% = $1.00; creator loyalty = 5% of that = $0.05
    expect(after - before).to.equal(50_000n);
  });
});

describe("HedgeFacet.claimPremiums — guards", function () {
  it("reverts for unknown deposit", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.lp1).claimPremiums(999n))
      .to.be.revertedWith("Deposit not found");
  });

  it("reverts when caller is not the deposit owner", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const { eventId } = await setup(hedge, signers);
    const creatorDepId = (await hedge.getLpDepositIds(signers.creator.address))[0];
    await expect(hedge.connect(signers.stranger).claimPremiums(creatorDepId))
      .to.be.revertedWith("Not your deposit");
  });

  it("reverts with no premiums to claim when none have accrued", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    // Event with no buys at all → creator deposit has zero accrued premium.
    await hedge.connect(signers.creator).createEvent(buildEventParams());
    const eventId = await hedge.getTotalHedgeEvents();
    const depId = (await hedge.getLpDepositIds(signers.creator.address))[0];
    await expect(hedge.connect(signers.creator).claimPremiums(depId))
      .to.be.revertedWith("No premiums to claim");
  });
});

describe("HedgeFacet.withdrawCapital — guards & loss-share math", function () {
  it("reverts for unknown deposit", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.lp1).withdrawCapital(999n))
      .to.be.revertedWith("Deposit not found");
  });

  it("reverts when caller is not the deposit owner", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const { eventId } = await setup(hedge, signers, { settlePrice: rate(11.5) });
    const creatorDepId = (await hedge.getLpDepositIds(signers.creator.address))[0];
    await expect(hedge.connect(signers.stranger).withdrawCapital(creatorDepId))
      .to.be.revertedWith("Not your deposit");
  });

  it("reverts while the event is still Open (capital locked)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const { eventId } = await setup(hedge, signers); // not settled
    const creatorDepId = (await hedge.getLpDepositIds(signers.creator.address))[0];
    await expect(hedge.connect(signers.creator).withdrawCapital(creatorDepId))
      .to.be.revertedWith("Cannot withdraw while event is active");
  });

  it("returns full capital when the event did not trigger", async function () {
    const { hedge, signers, usdc } = await loadFixture(deployDiamondFixture);
    const { eventId } = await setup(hedge, signers, { settlePrice: rate(10.5) }); // below strike
    const creatorDepId = (await hedge.getLpDepositIds(signers.creator.address))[0];
    const before = await usdc.balanceOf(signers.creator.address);
    await hedge.connect(signers.creator).withdrawCapital(creatorDepId);
    // Sole LP gets the full $10K deposit back (no payout deduction).
    expect(await usdc.balanceOf(signers.creator.address) - before).to.equal(10_000n * ONE_USDC);
  });

  it("deducts the proportional loss share when the event triggered", async function () {
    const { hedge, signers, usdc } = await loadFixture(deployDiamondFixture);
    // Sole LP (creator) = $10K. One $1K position. Settle at 11.5 → $50 payout.
    const { eventId } = await setup(hedge, signers, { settlePrice: rate(11.5) });
    const creatorDepId = (await hedge.getLpDepositIds(signers.creator.address))[0];
    const before = await usdc.balanceOf(signers.creator.address);
    await hedge.connect(signers.creator).withdrawCapital(creatorDepId);
    // lpPayoutShare = totalMaxPayout($50) × amount($10K) / liquidityAtSettlement($10K) = $50.
    // capital back = $10K − $50 = $9,950.
    expect(await usdc.balanceOf(signers.creator.address) - before).to.equal(9_950n * ONE_USDC);
  });

  it("blocks a second withdrawal", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const { eventId } = await setup(hedge, signers, { settlePrice: rate(10.5) });
    const creatorDepId = (await hedge.getLpDepositIds(signers.creator.address))[0];
    await hedge.connect(signers.creator).withdrawCapital(creatorDepId);
    await expect(hedge.connect(signers.creator).withdrawCapital(creatorDepId))
      .to.be.revertedWith("Already withdrawn");
  });

  it("withdrawal order does not change each LP's loss share (C-1 snapshot)", async function () {
    const { hedge, signers, usdc } = await loadFixture(deployDiamondFixture);
    // Two LPs each $10K → pool $20K. One $1K position → $50 payout at 11.5.
    await hedge.connect(signers.creator).createEvent(buildEventParams({ initialLiquidity: 10_000n * ONE_USDC }));
    const eventId = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.creator, eventId);
    await hedge.connect(signers.lp1).deposit(eventId, 10_000n * ONE_USDC);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await warpPastExpiry(hedge, eventId);
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11.5));

    const creatorDepId = (await hedge.getLpDepositIds(signers.creator.address))[0];
    const lp1DepId = (await hedge.getLpDepositIds(signers.lp1.address))[0];

    // lp1 withdraws first, then creator. Each share = $50 × 10K / 20K = $25.
    const lp1Before = await usdc.balanceOf(signers.lp1.address);
    await hedge.connect(signers.lp1).withdrawCapital(lp1DepId);
    expect(await usdc.balanceOf(signers.lp1.address) - lp1Before).to.equal(9_975n * ONE_USDC);

    const cBefore = await usdc.balanceOf(signers.creator.address);
    await hedge.connect(signers.creator).withdrawCapital(creatorDepId);
    // Denominator is the settlement snapshot, NOT the now-shrunken live liquidity → still $25 loss.
    expect(await usdc.balanceOf(signers.creator.address) - cBefore).to.equal(9_975n * ONE_USDC);
  });
});

describe("HedgeFacet.withdrawCreatorEarnings", function () {
  it("reverts for unknown event", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.creator).withdrawCreatorEarnings(999n))
      .to.be.revertedWith("Event not found");
  });

  it("reverts when caller is not the creator", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const { eventId } = await setup(hedge, signers);
    await expect(hedge.connect(signers.stranger).withdrawCreatorEarnings(eventId))
      .to.be.revertedWith("Not creator");
  });

  it("reverts when there are no earnings", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    // Event with no buys → no creator-loyalty accrued.
    await hedge.connect(signers.creator).createEvent(buildEventParams());
    const eventId = await hedge.getTotalHedgeEvents();
    await expect(hedge.connect(signers.creator).withdrawCreatorEarnings(eventId))
      .to.be.revertedWith("No earnings");
  });

  it("transfers accrued earnings and zeroes the balance", async function () {
    const { hedge, signers, usdc } = await loadFixture(deployDiamondFixture);
    const { eventId } = await setup(hedge, signers); // one buy → creator loyalty = 5% of the $1.25 platform fee
    const earnings = (await hedge.getHedgeEventStats(eventId)).creatorEarnings;
    expect(earnings).to.equal(62_500n);

    const before = await usdc.balanceOf(signers.creator.address);
    await expect(hedge.connect(signers.creator).withdrawCreatorEarnings(eventId))
      .to.emit(hedge, "CreatorEarningsWithdrawn");
    expect(await usdc.balanceOf(signers.creator.address) - before).to.equal(earnings);
    expect((await hedge.getHedgeEventStats(eventId)).creatorEarnings).to.equal(0n);
  });
});
