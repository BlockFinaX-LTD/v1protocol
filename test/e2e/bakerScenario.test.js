/**
 * bakerScenario.test.js — full lifecycle for the canonical baker example, three outcomes.
 *
 * Setup (identical for all three sub-cases):
 *   USD/GHS, initialRate = 10, strike = 11, payoutCap = 12 (range = $1 = 10% per notional)
 *   Creator seeds $10,000 liquidity. One external LP adds $5,000.
 *   Baker (hedger) buys $1,000 of protection.
 *
 * Three sub-cases differ only by settlement price:
 *   A) settlement at 10.5  → not triggered → baker gets $0, LPs keep premium and full deposits
 *   B) settlement at 11.5  → mid-range    → baker gets $50, LPs eat $50 of loss collectively
 *   C) settlement at 13    → above cap    → baker gets $100 (max), LPs eat $100 collectively
 *
 * For each: walk through the entire lifecycle, then assert every party's net P&L.
 *
 * Math reference for cross-checks (default fees: hedgerFeeRate 0.5%, hedgerPayoutFeeRate 1%,
 * lpProfitFeeRate 1%, creatorLoyaltyRate 5% of every fee):
 *   premium       = 1000 × 2.5%   = $25      (paid by baker → LPs via accumulator)
 *   platformFee   = 1000 × 0.5%   = $5       (paid by baker → platform + creator loyalty 5%)
 *     creator gets  $5 × 5%       = $0.25
 *     platform gets $5 - $0.25    = $4.75
 *   total cost to baker = $30
 *
 *   On payout claim ($100 case):
 *     payoutFee   = 100 × 1%      = $1
 *       creator gets   $1 × 5%    = $0.05
 *       platform gets  $1 - $0.05 = $0.95
 *     baker net  = 100 - 1 = $99
 *
 *   On premium claim by LPs ($25 split between $10K creator + $5K external LP):
 *     creator share = 25 × (10K/15K) = ~$16.67
 *     lp1 share     = 25 × ( 5K/15K) = ~$8.33
 *     lpProfitFee   = 1% deducted from the gross at claim
 *       creator side: $16.67 × 1% = $0.167  (split: creator-loyalty $0.0083, platform $0.158)
 *       lp1 side    : $8.33 × 1%  = $0.083  (split: $0.004 / $0.079)
 *     net to creator from premium claim = $16.67 - $0.167 = $16.50
 *     net to lp1 from premium claim    = $8.33  - $0.083 = $8.25
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

// Allow a small amount of integer-truncation drift in cross-checks. Sources of drift:
//   - accPremiumPerShare = scaledPremium / totalActiveShares may drop a few wei per buy
//     (the H-2 dust fix accumulates this until it crosses one full share unit, then flushes)
//   - lpPayoutShare = totalMaxPayout × deposit / refLiquidity rounds toward zero
//   - cascading creator-loyalty cuts on every fee compound the rounding
// Default tolerance: 100,000 wei = $0.10 USDC, plenty for sanity checks on $1K-$10K balances.
function near(actual, expected, tolerance = 100_000n) {
  const diff = actual > expected ? actual - expected : expected - actual;
  if (diff > tolerance) {
    throw new Error(`Expected ~${expected}, got ${actual} (diff ${diff} > tolerance ${tolerance})`);
  }
}

async function fullSetup() {
  const ctx = await loadFixture(deployDiamondFixture);
  const { hedge, signers } = ctx;

  // Creator seeds $10K and the event.
  await hedge.connect(signers.creator).createEvent(buildEventParams({
    initialLiquidity: 10_000n * ONE_USDC,
  }));
  const eventId = await hedge.getTotalHedgeEvents();

  // Open the pool.
  await openPool(hedge, signers.creator, eventId);

  // External LP1 adds $5K.
  await hedge.connect(signers.lp1).deposit(eventId, 5_000n * ONE_USDC);

  // Baker buys $1K of protection.
  await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

  return { ...ctx, eventId };
}

describe("E2E: Baker scenario — three settlement outcomes", function () {

  describe("Scenario A — settlement at 10.5 (no trigger)", function () {
    it("baker gets $0; LPs keep premium and full deposits", async function () {
      const { hedge, signers, usdc, eventId } = await fullSetup();

      // Capture pre-settlement balances.
      const balsBefore = {
        baker:   await usdc.balanceOf(signers.hedger1.address),
        creator: await usdc.balanceOf(signers.creator.address),
        lp1:     await usdc.balanceOf(signers.lp1.address),
      };

      // Settle below strike. Need to skip past expiry first because strike wasn't touched.
      const core = await hedge.getHedgeEventCore(eventId);
      await time.increaseTo(Number(core.expiryDate) + 1);
      await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(10.5));

      // Baker tries to claim — should revert (not eligible).
      const positionId = (await hedge.getEventPositionIds(eventId))[0];
      await expect(hedge.connect(signers.hedger1).claimPayout(positionId))
        .to.be.revertedWith("Not eligible for payout");

      // LPs claim premiums.
      const creatorDepositId = (await hedge.getLpDepositIds(signers.creator.address))[0];
      const lp1DepositId     = (await hedge.getLpDepositIds(signers.lp1.address))[0];
      await hedge.connect(signers.creator).claimPremiums(creatorDepositId);
      await hedge.connect(signers.lp1).claimPremiums(lp1DepositId);

      // LPs withdraw capital.
      await hedge.connect(signers.creator).withdrawCapital(creatorDepositId);
      await hedge.connect(signers.lp1).withdrawCapital(lp1DepositId);

      // Creator also withdraws creator-loyalty earnings.
      await hedge.connect(signers.creator).withdrawCreatorEarnings(eventId);

      const balsAfter = {
        baker:   await usdc.balanceOf(signers.hedger1.address),
        creator: await usdc.balanceOf(signers.creator.address),
        lp1:     await usdc.balanceOf(signers.lp1.address),
      };

      // Baker P&L: paid $30, got $0 → -$30
      expect(balsAfter.baker).to.equal(balsBefore.baker);

      // LP1: deposited $5K, gets back $5K + premium share ≈ $8.33 gross / $8.247 net (1% LP fee).
      const lp1Gain = balsAfter.lp1 - balsBefore.lp1;
      near(lp1Gain, 5_008_246_700n);

      // Creator: deposited $10K, gets back $10K + premium share ($16.493 net) + creator earnings
      // (~$0.262 from buy 5%-loyalty cut plus 5% of LP-fee-on-premium claims from both LPs).
      const creatorGain = balsAfter.creator - balsBefore.creator;
      near(creatorGain, 10_016_755_895n);
    });
  });

  describe("Scenario B — settlement at 11.5 (mid-range)", function () {
    it("baker gets $50 gross / $49.50 net; LPs collectively lose $50", async function () {
      const { hedge, signers, usdc, eventId } = await fullSetup();

      const balsBefore = {
        baker:   await usdc.balanceOf(signers.hedger1.address),
        creator: await usdc.balanceOf(signers.creator.address),
        lp1:     await usdc.balanceOf(signers.lp1.address),
      };

      await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11.5));

      // Baker claims payout.
      const positionId = (await hedge.getEventPositionIds(eventId))[0];
      await hedge.connect(signers.hedger1).claimPayout(positionId);

      // LPs claim premiums then withdraw.
      const creatorDepositId = (await hedge.getLpDepositIds(signers.creator.address))[0];
      const lp1DepositId     = (await hedge.getLpDepositIds(signers.lp1.address))[0];
      await hedge.connect(signers.creator).claimPremiums(creatorDepositId);
      await hedge.connect(signers.lp1).claimPremiums(lp1DepositId);
      await hedge.connect(signers.creator).withdrawCapital(creatorDepositId);
      await hedge.connect(signers.lp1).withdrawCapital(lp1DepositId);
      await hedge.connect(signers.creator).withdrawCreatorEarnings(eventId);

      const balsAfter = {
        baker:   await usdc.balanceOf(signers.hedger1.address),
        creator: await usdc.balanceOf(signers.creator.address),
        lp1:     await usdc.balanceOf(signers.lp1.address),
      };

      // Baker received $49.50 net ($50 gross - 1% fee).
      const bakerGain = balsAfter.baker - balsBefore.baker;
      expect(bakerGain).to.equal(49_500_000n);

      // LP1 share of $50 loss = $50 × 5K/15K = $16.666 (truncated). Capital back $4,983.333 + premium $8.247.
      const lp1Gain = balsAfter.lp1 - balsBefore.lp1;
      near(lp1Gain, 4_991_580_034n);

      // Creator: $10K - $33.333 loss + $16.493 premium net + $0.287 earnings (buy + payoutFee + premium-fee cuts)
      const creatorGain = balsAfter.creator - balsBefore.creator;
      near(creatorGain, 9_983_447_562n);
    });
  });

  describe("Scenario C — settlement at 13 (above cap)", function () {
    it("baker gets $100 gross / $99 net; LPs collectively lose the full $100", async function () {
      const { hedge, signers, usdc, eventId } = await fullSetup();

      const balsBefore = {
        baker:   await usdc.balanceOf(signers.hedger1.address),
        creator: await usdc.balanceOf(signers.creator.address),
        lp1:     await usdc.balanceOf(signers.lp1.address),
      };

      await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(13));

      const positionId = (await hedge.getEventPositionIds(eventId))[0];
      await hedge.connect(signers.hedger1).claimPayout(positionId);

      const creatorDepositId = (await hedge.getLpDepositIds(signers.creator.address))[0];
      const lp1DepositId     = (await hedge.getLpDepositIds(signers.lp1.address))[0];
      await hedge.connect(signers.creator).claimPremiums(creatorDepositId);
      await hedge.connect(signers.lp1).claimPremiums(lp1DepositId);
      await hedge.connect(signers.creator).withdrawCapital(creatorDepositId);
      await hedge.connect(signers.lp1).withdrawCapital(lp1DepositId);
      await hedge.connect(signers.creator).withdrawCreatorEarnings(eventId);

      const balsAfter = {
        baker:   await usdc.balanceOf(signers.hedger1.address),
        creator: await usdc.balanceOf(signers.creator.address),
        lp1:     await usdc.balanceOf(signers.lp1.address),
      };

      // Baker received $99 net.
      const bakerGain = balsAfter.baker - balsBefore.baker;
      expect(bakerGain).to.equal(99_000_000n);

      // LP1 share of $100 loss = $100 × 5K/15K = $33.333 (truncated). Capital $4,966.667 + premium $8.247.
      const lp1Gain = balsAfter.lp1 - balsBefore.lp1;
      near(lp1Gain, 4_974_913_367n);

      // Creator: $10K - $66.667 loss + $16.493 premium + $0.312 earnings (buy + bigger payoutFee + premium-fee cuts)
      const creatorGain = balsAfter.creator - balsBefore.creator;
      near(creatorGain, 9_950_139_229n);
    });

    it("does NOT exceed the maximum loss (100 USDC) regardless of settlement price", async function () {
      // Re-prove: settlement at 100 (way above cap) gives the SAME baker payout.
      const { hedge, signers, usdc, eventId } = await fullSetup();
      const balsBefore = await usdc.balanceOf(signers.hedger1.address);
      await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(100));
      const positionId = (await hedge.getEventPositionIds(eventId))[0];
      await hedge.connect(signers.hedger1).claimPayout(positionId);
      expect(await usdc.balanceOf(signers.hedger1.address) - balsBefore).to.equal(99_000_000n);
    });
  });

  describe("Conservation of value across all scenarios", function () {
    it("Σ(party balances) - protocol fees = sum of initial balances (no value created or destroyed)", async function () {
      const { hedge, signers, usdc, eventId } = await fullSetup();

      // Snapshot all party balances + diamond's USDC reserve before settlement.
      const initial = {
        baker:    await usdc.balanceOf(signers.hedger1.address),
        creator:  await usdc.balanceOf(signers.creator.address),
        lp1:      await usdc.balanceOf(signers.lp1.address),
        diamond:  await usdc.balanceOf((await hedge.getAddress())),
      };

      await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11.5));
      const positionId = (await hedge.getEventPositionIds(eventId))[0];
      await hedge.connect(signers.hedger1).claimPayout(positionId);

      const cId = (await hedge.getLpDepositIds(signers.creator.address))[0];
      const lId = (await hedge.getLpDepositIds(signers.lp1.address))[0];
      await hedge.connect(signers.creator).claimPremiums(cId);
      await hedge.connect(signers.lp1).claimPremiums(lId);
      await hedge.connect(signers.creator).withdrawCapital(cId);
      await hedge.connect(signers.lp1).withdrawCapital(lId);
      await hedge.connect(signers.creator).withdrawCreatorEarnings(eventId);

      // Owner withdraws platform fees so all USDC has flowed out.
      const platformFees = await hedge.getHedgePlatformFees();
      if (platformFees > 0n) {
        await hedge.connect(signers.owner).withdrawPlatformFees(platformFees);
      }

      const final = {
        baker:    await usdc.balanceOf(signers.hedger1.address),
        creator:  await usdc.balanceOf(signers.creator.address),
        lp1:      await usdc.balanceOf(signers.lp1.address),
        owner:    await usdc.balanceOf(signers.owner.address),
        diamond:  await usdc.balanceOf((await hedge.getAddress())),
      };

      // No funds stranded in the Diamond beyond expected dust.
      // The H-2 fix accumulates per-share-truncation remainders in evt.premiumDust until
      // enough builds up to redistribute. With 1 buyProtection() in this test the dust
      // is at most (totalActiveShares - 1) raw units in the accumulator, which scales
      // back down to ≤ 1 USDC microcent in payment-token terms (≤ 10,000 wei = $0.01).
      expect(final.diamond).to.be.lte(10_000n);

      // Conservation: initial total = final total (all funds went somewhere).
      const initialSum = initial.baker + initial.creator + initial.lp1 + initial.diamond;
      const finalSum = final.baker + final.creator + final.lp1 + final.owner + final.diamond;
      expect(finalSum).to.equal(initialSum);
    });
  });
});
