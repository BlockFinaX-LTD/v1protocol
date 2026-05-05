/**
 * masterchef.test.js — proves the MasterChef-style premium accumulator distributes
 * fairly when LPs join at DIFFERENT times relative to buyProtection() calls.
 *
 * The invariant being tested: an LP only earns premiums distributed AFTER they joined.
 * The mechanic: rewardDebt is set at deposit time to (shares × accPremiumPerShare).
 *               At claim time, claimable = (shares × accPremiumPerShare) - rewardDebt.
 *
 * Scenario:
 *   t=0   Creator opens event with $10K liquidity.
 *   t=1   buyProtection #1 ($1K notional, $25 premium) — flows to creator only.
 *   t=2   LP1 deposits $5K. (Should NOT receive any of premium #1.)
 *   t=3   buyProtection #2 ($2K notional, $50 premium) — flows to creator (10/15) + LP1 (5/15).
 *   t=4   LP2 deposits $5K. (Should NOT receive any of premiums #1 or #2.)
 *   t=5   buyProtection #3 ($1K notional, $25 premium) — flows to creator (10/20) + LP1 (5/20) + LP2 (5/20).
 *
 * Expected pendingPremiums at t=5:
 *   creator: 25 + 50×(10/15) + 25×(10/20) = 25 + 33.333 + 12.5 = 70.833
 *   LP1:           50×(5/15)  + 25×(5/20) =       16.667 + 6.25 = 22.917
 *   LP2:                       25×(5/20) =                 6.25
 *   Σ pending = 100 USDC = sum of all three premiums (modulo dust)
 *
 * This file also covers:
 *   - LP that deposits AFTER all buys gets zero pending premiums
 *   - claimPremiums claims exactly the pending amount
 *   - dust is preserved across multiple buys (premium total goes to zero +/- dust)
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

// Loose tolerance for integer-truncation drift in per-share accumulator.
function near(actual, expected, tolerance = 100_000n) {
  const diff = actual > expected ? actual - expected : expected - actual;
  if (diff > tolerance) {
    throw new Error(`Expected ~${expected}, got ${actual} (diff ${diff} > tolerance ${tolerance})`);
  }
}

describe("E2E: MasterChef premium accumulator — late-joiner fairness", function () {
  it("distributes each premium only to LPs present at the time of buy", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);

    // t=0 — creator seeds $10K.
    await hedge.connect(signers.creator).createEvent(buildEventParams({
      initialLiquidity: 10_000n * ONE_USDC,
    }));
    const eventId = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.creator, eventId);

    const creatorDepId = (await hedge.getLpDepositIds(signers.creator.address))[0];

    // t=1 — buyProtection #1: $1K notional → $25 premium → goes 100% to creator.
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    let pendingCreator = await hedge.pendingPremiums(creatorDepId);
    near(pendingCreator, 25n * ONE_USDC);

    // t=2 — LP1 joins with $5K. Pool is now $15K (10K creator + 5K lp1).
    await hedge.connect(signers.lp1).deposit(eventId, 5_000n * ONE_USDC);
    const lp1DepId = (await hedge.getLpDepositIds(signers.lp1.address))[0];

    // CRITICAL: LP1's pending should be 0 even though premium #1 already happened.
    // This is the rewardDebt mechanic — LP1 was assigned the running accumulator value at
    // deposit time, so the (shares × accPremiumPerShare) snapshot subtracts back to zero.
    expect(await hedge.pendingPremiums(lp1DepId)).to.equal(0n);

    // t=3 — buyProtection #2: $2K notional → $50 premium → split 10K/5K = 2:1 between creator and LP1.
    await hedge.connect(signers.hedger2).buyProtection(eventId, 2_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    pendingCreator = await hedge.pendingPremiums(creatorDepId);
    let pendingLp1   = await hedge.pendingPremiums(lp1DepId);
    // Creator now: 25 (premium #1) + 33.333 (2/3 of premium #2) ≈ 58.333
    near(pendingCreator, 58_333_333n);
    // LP1: 0 (premium #1, missed) + 16.667 (1/3 of premium #2)
    near(pendingLp1,     16_666_666n);

    // t=4 — LP2 joins with $5K. Pool is now $20K.
    await hedge.connect(signers.lp2).deposit(eventId, 5_000n * ONE_USDC);
    const lp2DepId = (await hedge.getLpDepositIds(signers.lp2.address))[0];
    expect(await hedge.pendingPremiums(lp2DepId)).to.equal(0n);

    // t=5 — buyProtection #3: $1K notional → $25 premium → split 10K/5K/5K = 2:1:1
    await hedge.connect(signers.hedger3).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    pendingCreator = await hedge.pendingPremiums(creatorDepId);
    pendingLp1     = await hedge.pendingPremiums(lp1DepId);
    let pendingLp2 = await hedge.pendingPremiums(lp2DepId);

    // Expected at t=5:
    //   creator: 25 + 33.333 + 12.5 = 70.833
    //   LP1:           16.667 + 6.25 = 22.917
    //   LP2:                    6.25 = 6.25
    near(pendingCreator, 70_833_333n);
    near(pendingLp1,     22_916_666n);
    near(pendingLp2,      6_250_000n);

    // Σ pending should equal Σ premiums (100 USDC) modulo accumulator dust.
    // Per H-2 fix, each buy can leave up to (totalActiveShares - 1) raw accumulator units
    // unflushed in evt.premiumDust. Across three buys that's at most 3 × (a few thousand wei).
    const sumPending = pendingCreator + pendingLp1 + pendingLp2;
    near(sumPending, 100n * ONE_USDC, 10_000n);
  });

  it("an LP that deposits AFTER all buys gets exactly zero pending premiums", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);

    await hedge.connect(signers.creator).createEvent(buildEventParams({
      initialLiquidity: 10_000n * ONE_USDC,
    }));
    const eventId = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.creator, eventId);

    // Several buys happen first.
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await hedge.connect(signers.hedger2).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await hedge.connect(signers.hedger3).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    // Late LP joins.
    await hedge.connect(signers.lp1).deposit(eventId, 5_000n * ONE_USDC);
    const lateDepId = (await hedge.getLpDepositIds(signers.lp1.address))[0];

    expect(await hedge.pendingPremiums(lateDepId)).to.equal(0n);
    await expect(hedge.connect(signers.lp1).claimPremiums(lateDepId))
      .to.be.revertedWith("No premiums to claim");
  });

  it("claimPremiums actually transfers exactly pendingPremiums (minus 1% LP fee)", async function () {
    const { hedge, usdc, signers } = await loadFixture(deployDiamondFixture);

    await hedge.connect(signers.creator).createEvent(buildEventParams({
      initialLiquidity: 10_000n * ONE_USDC,
    }));
    const eventId = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.creator, eventId);
    await hedge.connect(signers.lp1).deposit(eventId, 10_000n * ONE_USDC);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    const creatorDepId = (await hedge.getLpDepositIds(signers.creator.address))[0];
    const pending = await hedge.pendingPremiums(creatorDepId);
    expect(pending).to.equal(12n * ONE_USDC + 500_000n); // half of $25 = $12.50

    const lpFee = (pending * 10_000n) / 1_000_000n; // 1%
    const expectedNet = pending - lpFee;

    const balBefore = await usdc.balanceOf(signers.creator.address);
    await hedge.connect(signers.creator).claimPremiums(creatorDepId);
    const balAfter = await usdc.balanceOf(signers.creator.address);

    expect(balAfter - balBefore).to.equal(expectedNet);
    // After claim, pending must be zero.
    expect(await hedge.pendingPremiums(creatorDepId)).to.equal(0n);
  });

  it("a second claimPremiums in the same epoch reverts with No premiums to claim", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);

    await hedge.connect(signers.creator).createEvent(buildEventParams({
      initialLiquidity: 10_000n * ONE_USDC,
    }));
    const eventId = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.creator, eventId);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    const creatorDepId = (await hedge.getLpDepositIds(signers.creator.address))[0];
    await hedge.connect(signers.creator).claimPremiums(creatorDepId);
    await expect(hedge.connect(signers.creator).claimPremiums(creatorDepId))
      .to.be.revertedWith("No premiums to claim");
  });

  it("withdrawn LP cannot claim further premiums (H-01 fix)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);

    await hedge.connect(signers.creator).createEvent(buildEventParams({
      initialLiquidity: 10_000n * ONE_USDC,
    }));
    const eventId = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.creator, eventId);
    await hedge.connect(signers.lp1).deposit(eventId, 5_000n * ONE_USDC);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    // Settle (not triggered) so LP can withdraw capital.
    const core = await hedge.getHedgeEventCore(eventId);
    const { time } = require("@nomicfoundation/hardhat-network-helpers");
    await time.increaseTo(Number(core.expiryDate) + 1);
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(10.5));

    const lp1DepId = (await hedge.getLpDepositIds(signers.lp1.address))[0];
    // First claim premiums OK.
    await hedge.connect(signers.lp1).claimPremiums(lp1DepId);
    // Then withdraw capital.
    await hedge.connect(signers.lp1).withdrawCapital(lp1DepId);
    // Any further claim must revert per H-01.
    await expect(hedge.connect(signers.lp1).claimPremiums(lp1DepId))
      .to.be.revertedWith("Capital already withdrawn: cannot claim premiums");
  });
});
