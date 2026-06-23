/**
 * oracleParity.test.js — proves multi-oracle consensus settlement and single-key
 * settlement leave the Diamond in IDENTICAL state for the same event params.
 *
 * Strategy: create two events with identical params. Settle one via HedgeFacet.settleEvent
 * (single-key) and the other via the OracleFacet consensus path (3 oracles submitting the
 * same price). After both have settled, every observable field should match.
 *
 * Also covers oracle-side edge cases that affect downstream state:
 *   - submitRate honours the resubmit cooldown
 *   - spread > toleranceBps clears submissions and DOES NOT settle
 *   - admin can clear stale submissions to unstick a stuck event
 *   - removeOracle blocks falling below requiredSigners
 */

const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
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
const HedgeStatus    = { Open: 0, Settled: 1, Expired: 2 };

async function setupConsensusOracle(oracle, owner, oracleSigners, threshold = 2) {
  for (const s of oracleSigners) {
    await oracle.connect(owner).addOracle(s.address);
  }
  await oracle.connect(owner).setRequiredSigners(threshold);
}

async function makeOpenEvent(hedge, signers, overrides = {}) {
  await hedge.connect(signers.creator).createEvent(buildEventParams(overrides));
  const eventId = await hedge.getTotalHedgeEvents();
  await openPool(hedge, signers.creator, eventId);
  return eventId;
}

describe("Oracle parity — single-key vs multi-oracle settlement", function () {

  it("produces identical event + position state for the same range mode settlement", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await setupConsensusOracle(oracle, signers.owner, [signers.oracleA, signers.oracleB, signers.oracleC], 2);

    // Create two identical events.
    const eventA = await makeOpenEvent(hedge, signers); // strike=11, payoutCap=12, initialRate=10
    const eventB = await makeOpenEvent(hedge, signers);

    // Identical hedger positions on both events.
    await hedge.connect(signers.hedger1).buyProtection(eventA, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await hedge.connect(signers.hedger2).buyProtection(eventA, 2_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await hedge.connect(signers.hedger1).buyProtection(eventB, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await hedge.connect(signers.hedger2).buyProtection(eventB, 2_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    // European settlement: both events can only settle at/after expiry. Both were created
    // with the same default expiry, so one warp covers both.
    await warpPastExpiry(hedge, eventB);

    // Settle A via single-key admin.
    await hedge.connect(signers.oracleAdmin).settleEvent(eventA, rate(11.5));

    // Settle B via multi-oracle consensus.
    await oracle.connect(signers.oracleA).submitRate(eventB, rate(11.5));
    await oracle.connect(signers.oracleB).submitRate(eventB, rate(11.5));
    // Two agreeing submissions = consensus → auto-settle in same tx.

    // Compare event-level state.
    const statsA = await hedge.getHedgeEventStats(eventA);
    const statsB = await hedge.getHedgeEventStats(eventB);
    expect(statsA.settlementPrice).to.equal(statsB.settlementPrice);
    expect(statsA.triggered).to.equal(statsB.triggered);
    expect(statsA.totalMaxPayout).to.equal(statsB.totalMaxPayout);
    expect(statsA.totalLiquidity).to.equal(statsB.totalLiquidity);

    const coreA = await hedge.getHedgeEventCore(eventA);
    const coreB = await hedge.getHedgeEventCore(eventB);
    expect(coreA.status).to.equal(coreB.status);
    expect(coreA.status).to.equal(HedgeStatus.Settled);

    // Compare per-position state.
    const posIdsA = await hedge.getEventPositionIds(eventA);
    const posIdsB = await hedge.getEventPositionIds(eventB);
    expect(posIdsA.length).to.equal(posIdsB.length);
    for (let i = 0; i < posIdsA.length; i++) {
      const pA = await hedge.getHedgePosition(posIdsA[i]);
      const pB = await hedge.getHedgePosition(posIdsB[i]);
      expect(pA.payoutAmount).to.equal(pB.payoutAmount);
      expect(pA.status).to.equal(pB.status);
    }
  });

  it("identical results for not-triggered settlement", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await setupConsensusOracle(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);

    const eventA = await makeOpenEvent(hedge, signers);
    const eventB = await makeOpenEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventA, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await hedge.connect(signers.hedger1).buyProtection(eventB, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    // Below strike → must time-travel past expiry.
    const core = await hedge.getHedgeEventCore(eventA);
    await time.increaseTo(Number(core.expiryDate) + 1);

    await hedge.connect(signers.oracleAdmin).settleEvent(eventA, rate(10.5));
    await oracle.connect(signers.oracleA).submitRate(eventB, rate(10.5));
    await oracle.connect(signers.oracleB).submitRate(eventB, rate(10.5));

    const statsA = await hedge.getHedgeEventStats(eventA);
    const statsB = await hedge.getHedgeEventStats(eventB);
    expect(statsA.triggered).to.equal(false);
    expect(statsB.triggered).to.equal(false);
    expect(statsA.totalMaxPayout).to.equal(0n);
    expect(statsB.totalMaxPayout).to.equal(0n);
  });

  it("identical results for single-strike (legacy) mode", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await setupConsensusOracle(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);

    const eventA = await makeOpenEvent(hedge, signers, { payoutCap: 0n });
    const eventB = await makeOpenEvent(hedge, signers, { payoutCap: 0n });
    await hedge.connect(signers.hedger1).buyProtection(eventA, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await hedge.connect(signers.hedger1).buyProtection(eventB, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    await warpPastExpiry(hedge, eventB);
    await hedge.connect(signers.oracleAdmin).settleEvent(eventA, rate(11.5));
    await oracle.connect(signers.oracleA).submitRate(eventB, rate(11.5));
    await oracle.connect(signers.oracleB).submitRate(eventB, rate(11.5));

    const posA = await hedge.getHedgePosition((await hedge.getEventPositionIds(eventA))[0]);
    const posB = await hedge.getHedgePosition((await hedge.getEventPositionIds(eventB))[0]);
    expect(posA.payoutAmount).to.equal(posB.payoutAmount);
    expect(posA.payoutAmount).to.equal(100n * ONE_USDC); // full digital payout
    expect(posA.status).to.equal(posB.status);
  });
});

describe("Oracle consensus mechanics", function () {
  it("single submission below requiredSigners does NOT settle", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await setupConsensusOracle(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);

    const eventId = await makeOpenEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await warpPastExpiry(hedge, eventId);
    await oracle.connect(signers.oracleA).submitRate(eventId, rate(11.5));

    const core = await hedge.getHedgeEventCore(eventId);
    expect(core.status).to.equal(HedgeStatus.Open);
  });

  it("clears submissions when spread exceeds toleranceBps", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await setupConsensusOracle(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    // default tolerance = 100 bps (1%)

    const eventId = await makeOpenEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    // 11.0 vs 11.5 = ~4.5% spread → way over tolerance → clear, no settlement.
    await warpPastExpiry(hedge, eventId);
    await oracle.connect(signers.oracleA).submitRate(eventId, rate(11));
    await oracle.connect(signers.oracleB).submitRate(eventId, rate(11.5));

    const core = await hedge.getHedgeEventCore(eventId);
    expect(core.status).to.equal(HedgeStatus.Open); // unchanged
    // submitters should be cleared; submitter count == 0
    expect(await oracle.getSubmitterCount(eventId)).to.equal(0n);
  });

  it("RESUBMIT_COOLDOWN blocks rapid re-submission from same oracle", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await setupConsensusOracle(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    const eventId = await makeOpenEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    await warpPastExpiry(hedge, eventId);
    await oracle.connect(signers.oracleA).submitRate(eventId, rate(11.2));
    // Same oracle tries to overwrite immediately.
    await expect(oracle.connect(signers.oracleA).submitRate(eventId, rate(11.3)))
      .to.be.revertedWith("Resubmit cooldown: wait 5 minutes between submissions for this event");
  });

  it("removeOracle reverts if it would drop below requiredSigners", async function () {
    const { oracle, signers } = await loadFixture(deployDiamondFixture);
    await setupConsensusOracle(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    await expect(oracle.connect(signers.owner).removeOracle(signers.oracleA.address))
      .to.be.revertedWith("Removing this oracle would violate quorum (oracle count would drop below requiredSigners)");
  });

  it("clearStaleSubmissions: admin can unstick a stuck event", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await setupConsensusOracle(oracle, signers.owner, [signers.oracleA, signers.oracleB, signers.oracleC], 3);
    const eventId = await makeOpenEvent(hedge, signers);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);

    // 1 of 3 submits, then stalls.
    await warpPastExpiry(hedge, eventId);
    await oracle.connect(signers.oracleA).submitRate(eventId, rate(11.5));
    expect(await oracle.getSubmitterCount(eventId)).to.equal(1n);

    await oracle.connect(signers.owner).clearStaleSubmissions(eventId);
    expect(await oracle.getSubmitterCount(eventId)).to.equal(0n);
  });
});
