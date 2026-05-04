/**
 * recoverExpiredPayouts.test.js — sweeping unclaimed Claimable payouts to platform fees
 * after the 90-day grace window. This is the protocol's escape hatch so funds reserved
 * for hedgers who never returned to claim don't sit in the contract forever.
 *
 * Covers:
 *   Reverts:
 *     - event not found
 *     - event still Open (not yet settled)
 *     - event settled but not triggered (no payouts to recover)
 *     - within the 90-day grace period
 *     - no Claimable positions remain (all hedgers already claimed → residual = 0)
 *
 *   Successful sweep:
 *     - All Claimable positions have payoutAmount zeroed and become Expired
 *     - The residual is added to platformFees / platformFeesByToken[USDC]
 *     - The owner can subsequently withdraw the residual via withdrawPlatformFees
 *
 *   Late-claiming hedger after recovery:
 *     - cannot claim — their position is now Expired, claimPayout reverts
 *
 *   Idempotency:
 *     - second call after recovery reverts ("No unclaimed payouts to recover")
 *
 *   Mixed claim states:
 *     - some hedgers claim, some don't, recovery only sweeps the unclaimed
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
const GRACE_PERIOD = 90 * 24 * 60 * 60; // 90 days

const PositionStatus = { Active: 0, SettledWin: 1, SettledLoss: 2, Claimed: 3, Claimable: 4, Expired: 5 };

async function setupTriggeredEvent(hedge, signers, hedgers = [{ signer: null, notional: 1_000n * ONE_USDC }]) {
  await hedge.connect(signers.creator).createEvent(buildEventParams({ initialLiquidity: 10_000n * ONE_USDC }));
  const eventId = await hedge.getTotalHedgeEvents();
  await openPool(hedge, signers.creator, eventId);
  for (const h of hedgers) {
    await hedge.connect(h.signer).buyProtection(eventId, h.notional, MAX_UINT, FAR_FUTURE);
  }
  // Trigger by settling above strike (range mid).
  await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11.5));
  return eventId;
}

describe("HedgeFacet.recoverExpiredPayouts — reverts", function () {

  it("event not found", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.owner).recoverExpiredPayouts(999n))
      .to.be.revertedWith("Event not found");
  });

  it("event not yet settled", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await hedge.connect(signers.creator).createEvent(buildEventParams());
    const eventId = await hedge.getTotalHedgeEvents();
    await expect(hedge.connect(signers.owner).recoverExpiredPayouts(eventId))
      .to.be.revertedWith("Event not settled");
  });

  it("event settled but not triggered", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await hedge.connect(signers.creator).createEvent(buildEventParams());
    const eventId = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.creator, eventId);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    // Settle below strike (after expiry).
    const core = await hedge.getHedgeEventCore(eventId);
    await time.increaseTo(Number(core.expiryDate) + 1);
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(10.5));
    await time.increase(GRACE_PERIOD + 1);
    await expect(hedge.connect(signers.owner).recoverExpiredPayouts(eventId))
      .to.be.revertedWith("Event did not trigger: no payouts reserved");
  });

  it("within the 90-day grace period", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupTriggeredEvent(hedge, signers, [
      { signer: signers.hedger1, notional: 1_000n * ONE_USDC },
    ]);
    // 89 days later, still inside grace.
    await time.increase(GRACE_PERIOD - 24 * 60 * 60);
    await expect(hedge.connect(signers.owner).recoverExpiredPayouts(eventId))
      .to.be.revertedWith("Grace period not elapsed (90 days from settlement)");
  });

  it("no Claimable positions remain (all hedgers already claimed)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupTriggeredEvent(hedge, signers, [
      { signer: signers.hedger1, notional: 1_000n * ONE_USDC },
    ]);
    const positionId = (await hedge.getEventPositionIds(eventId))[0];
    await hedge.connect(signers.hedger1).claimPayout(positionId);
    await time.increase(GRACE_PERIOD + 1);
    await expect(hedge.connect(signers.owner).recoverExpiredPayouts(eventId))
      .to.be.revertedWith("No unclaimed payouts to recover");
  });
});

describe("HedgeFacet.recoverExpiredPayouts — successful sweep", function () {

  it("sweeps unclaimed payout into platform fees and zeros position state", async function () {
    const { hedge, signers, usdc, addresses } = await loadFixture(deployDiamondFixture);
    const eventId = await setupTriggeredEvent(hedge, signers, [
      { signer: signers.hedger1, notional: 1_000n * ONE_USDC }, // payout = $50 at settlement 11.5
    ]);
    const positionId = (await hedge.getEventPositionIds(eventId))[0];

    // Hedger never returns. Time passes.
    await time.increase(GRACE_PERIOD + 1);

    const platformBefore = await hedge.getHedgePlatformFees();
    await hedge.connect(signers.owner).recoverExpiredPayouts(eventId);

    // Position is now Expired with payoutAmount = 0.
    const pos = await hedge.getHedgePosition(positionId);
    expect(pos.payoutAmount).to.equal(0n);
    expect(pos.status).to.equal(PositionStatus.Expired);

    // Platform fees grew by $50.
    const platformAfter = await hedge.getHedgePlatformFees();
    expect(platformAfter - platformBefore).to.equal(50n * ONE_USDC);

    // Owner can withdraw it.
    const balBefore = await usdc.balanceOf(signers.owner.address);
    await hedge.connect(signers.owner).withdrawPlatformFees(50n * ONE_USDC);
    expect(await usdc.balanceOf(signers.owner.address) - balBefore).to.equal(50n * ONE_USDC);
  });

  it("anyone can call recoverExpiredPayouts (it's permissionless by design)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupTriggeredEvent(hedge, signers, [
      { signer: signers.hedger1, notional: 1_000n * ONE_USDC },
    ]);
    await time.increase(GRACE_PERIOD + 1);
    // Stranger can call it — there's no onlyOwner guard.
    await expect(hedge.connect(signers.stranger).recoverExpiredPayouts(eventId))
      .to.not.be.reverted;
  });

  it("late-claiming hedger after recovery cannot claim — their position is Expired", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupTriggeredEvent(hedge, signers, [
      { signer: signers.hedger1, notional: 1_000n * ONE_USDC },
    ]);
    const positionId = (await hedge.getEventPositionIds(eventId))[0];

    await time.increase(GRACE_PERIOD + 1);
    await hedge.connect(signers.owner).recoverExpiredPayouts(eventId);

    await expect(hedge.connect(signers.hedger1).claimPayout(positionId))
      .to.be.revertedWith("Not eligible for payout");
  });

  it("idempotent: second call after recovery reverts", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupTriggeredEvent(hedge, signers, [
      { signer: signers.hedger1, notional: 1_000n * ONE_USDC },
    ]);
    await time.increase(GRACE_PERIOD + 1);
    await hedge.connect(signers.owner).recoverExpiredPayouts(eventId);
    await expect(hedge.connect(signers.owner).recoverExpiredPayouts(eventId))
      .to.be.revertedWith("No unclaimed payouts to recover");
  });

  it("mixed claim state: only the still-Claimable positions are swept", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await setupTriggeredEvent(hedge, signers, [
      { signer: signers.hedger1, notional: 1_000n * ONE_USDC }, // $50 payout
      { signer: signers.hedger2, notional: 2_000n * ONE_USDC }, // $100 payout
      { signer: signers.hedger3, notional: 3_000n * ONE_USDC }, // $150 payout
    ]);
    const [pid1, pid2, pid3] = await hedge.getEventPositionIds(eventId);

    // Hedger2 claims promptly. Others don't.
    await hedge.connect(signers.hedger2).claimPayout(pid2);

    await time.increase(GRACE_PERIOD + 1);
    const platformBefore = await hedge.getHedgePlatformFees();
    await hedge.connect(signers.owner).recoverExpiredPayouts(eventId);
    const platformAfter = await hedge.getHedgePlatformFees();

    // Recovered $50 (hedger1) + $150 (hedger3) = $200
    expect(platformAfter - platformBefore).to.equal(200n * ONE_USDC);

    // hedger2's position remains Claimed (already claimed before sweep).
    expect((await hedge.getHedgePosition(pid2)).status).to.equal(PositionStatus.Claimed);
    // hedger1 & 3 are now Expired.
    expect((await hedge.getHedgePosition(pid1)).status).to.equal(PositionStatus.Expired);
    expect((await hedge.getHedgePosition(pid3)).status).to.equal(PositionStatus.Expired);
  });
});
