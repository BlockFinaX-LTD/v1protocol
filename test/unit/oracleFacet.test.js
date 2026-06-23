/**
 * oracleFacet.test.js — BlockFinaXOracleFacet admin, views, submission guards, and the
 * consensus engine (averaging, tolerance, staleness). The oracleParity integration test
 * proves single-key vs consensus parity; this file exhaustively covers the facet's own
 * branches in isolation.
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
const HedgeStatus = { Open: 0, Settled: 1, Expired: 2 };
const STALE_THRESHOLD = 15 * 60;
const RESUBMIT_COOLDOWN = 5 * 60;

async function registerOracles(oracle, owner, list, required = 2) {
  for (const o of list) await oracle.connect(owner).addOracle(o.address);
  if (required !== 2) await oracle.connect(owner).setRequiredSigners(required);
}

// Create + open + buy + warp past expiry so submitRate is allowed (European settlement).
async function settleableEvent(hedge, signers, overrides = {}) {
  await hedge.connect(signers.creator).createEvent(buildEventParams(overrides));
  const eventId = await hedge.getTotalHedgeEvents();
  await openPool(hedge, signers.creator, eventId);
  await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
  await warpPastExpiry(hedge, eventId);
  return eventId;
}

describe("OracleFacet.addOracle", function () {
  it("only owner", async function () {
    const { oracle, signers } = await loadFixture(deployDiamondFixture);
    await expect(oracle.connect(signers.stranger).addOracle(signers.oracleA.address))
      .to.be.revertedWith("Not owner");
  });

  it("rejects zero address", async function () {
    const { oracle, signers } = await loadFixture(deployDiamondFixture);
    await expect(oracle.connect(signers.owner).addOracle(ethers.ZeroAddress))
      .to.be.revertedWith("Zero address");
  });

  it("rejects duplicate registration", async function () {
    const { oracle, signers } = await loadFixture(deployDiamondFixture);
    await oracle.connect(signers.owner).addOracle(signers.oracleA.address);
    await expect(oracle.connect(signers.owner).addOracle(signers.oracleA.address))
      .to.be.revertedWith("Already registered");
  });

  it("first add initialises defaults (requiredSigners=2, toleranceBps=100) and emits events", async function () {
    const { oracle, signers } = await loadFixture(deployDiamondFixture);
    await expect(oracle.connect(signers.owner).addOracle(signers.oracleA.address))
      .to.emit(oracle, "OracleConfigUpdated").withArgs(2n, 100n)
      .and.to.emit(oracle, "OracleAdded").withArgs(signers.oracleA.address);
    const cfg = await oracle.getOracleConfig();
    expect(cfg.requiredSigners).to.equal(2n);
    expect(cfg.toleranceBps).to.equal(100n);
    expect(cfg.oracleCount).to.equal(1n);
    expect(cfg.maxOracles).to.equal(10n);
  });

  it("enforces MAX_ORACLES = 10", async function () {
    const { oracle, signers } = await loadFixture(deployDiamondFixture);
    // Register 10 random oracle wallets.
    for (let i = 0; i < 10; i++) {
      await oracle.connect(signers.owner).addOracle(ethers.Wallet.createRandom().address);
    }
    await expect(oracle.connect(signers.owner).addOracle(ethers.Wallet.createRandom().address))
      .to.be.revertedWith("Max oracle count reached (10)");
  });
});

describe("OracleFacet.removeOracle", function () {
  it("only owner", async function () {
    const { oracle, signers } = await loadFixture(deployDiamondFixture);
    await oracle.connect(signers.owner).addOracle(signers.oracleA.address);
    await expect(oracle.connect(signers.stranger).removeOracle(signers.oracleA.address))
      .to.be.revertedWith("Not owner");
  });

  it("rejects removing an unregistered oracle", async function () {
    const { oracle, signers } = await loadFixture(deployDiamondFixture);
    await expect(oracle.connect(signers.owner).removeOracle(signers.oracleA.address))
      .to.be.revertedWith("Not registered");
  });

  it("removes via swap-and-pop and updates getOracles / isAuthorisedOracle", async function () {
    const { oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB, signers.oracleC], 2);
    await oracle.connect(signers.owner).removeOracle(signers.oracleA.address);
    expect(await oracle.isAuthorisedOracle(signers.oracleA.address)).to.equal(false);
    const list = (await oracle.getOracles()).map(a => a.toLowerCase());
    expect(list.includes(signers.oracleA.address.toLowerCase())).to.equal(false);
    expect(list.length).to.equal(2);
  });

  it("blocks a removal that would drop below requiredSigners", async function () {
    const { oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    await expect(oracle.connect(signers.owner).removeOracle(signers.oracleA.address))
      .to.be.revertedWith("Removing this oracle would violate quorum (oracle count would drop below requiredSigners)");
  });
});

describe("OracleFacet.setRequiredSigners / setToleranceBps", function () {
  it("setRequiredSigners: only owner, min 2, cannot exceed oracle count", async function () {
    const { oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB, signers.oracleC], 2);
    await expect(oracle.connect(signers.stranger).setRequiredSigners(2))
      .to.be.revertedWith("Not owner");
    await expect(oracle.connect(signers.owner).setRequiredSigners(1))
      .to.be.revertedWith("Minimum 2 signers required");
    await expect(oracle.connect(signers.owner).setRequiredSigners(4))
      .to.be.revertedWith("Exceeds oracle count");
    await expect(oracle.connect(signers.owner).setRequiredSigners(3))
      .to.emit(oracle, "OracleConfigUpdated").withArgs(3n, 100n);
  });

  it("setToleranceBps: only owner, capped at 1000 (10%)", async function () {
    const { oracle, signers } = await loadFixture(deployDiamondFixture);
    await oracle.connect(signers.owner).addOracle(signers.oracleA.address);
    await expect(oracle.connect(signers.stranger).setToleranceBps(50))
      .to.be.revertedWith("Not owner");
    await expect(oracle.connect(signers.owner).setToleranceBps(1001))
      .to.be.revertedWith("Max 10% tolerance");
    await expect(oracle.connect(signers.owner).setToleranceBps(250))
      .to.emit(oracle, "OracleConfigUpdated").withArgs(2n, 250n);
    expect((await oracle.getOracleConfig()).toleranceBps).to.equal(250n);
  });
});

describe("OracleFacet.submitRate — guards", function () {
  it("rejects callers that are not registered oracles", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    const eventId = await settleableEvent(hedge, signers);
    await expect(oracle.connect(signers.stranger).submitRate(eventId, rate(11.5)))
      .to.be.revertedWith("Not an authorised oracle");
  });

  it("rejects unknown event", async function () {
    const { oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    await expect(oracle.connect(signers.oracleA).submitRate(999n, rate(11.5)))
      .to.be.revertedWith("Event not found");
  });

  it("rejects price of zero", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    const eventId = await settleableEvent(hedge, signers);
    await expect(oracle.connect(signers.oracleA).submitRate(eventId, 0n))
      .to.be.revertedWith("Invalid price");
  });

  it("rejects submission BEFORE expiry (European settlement)", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    // Create + open + buy but do NOT warp.
    await hedge.connect(signers.creator).createEvent(buildEventParams());
    const eventId = await hedge.getTotalHedgeEvents();
    await openPool(hedge, signers.creator, eventId);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await expect(oracle.connect(signers.oracleA).submitRate(eventId, rate(11.5)))
      .to.be.revertedWith("Too early: settlement only allowed at or after expiry");
  });

  it("rejects submission after the event is already settled", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    const eventId = await settleableEvent(hedge, signers);
    // Settle via single-key first (oracleAdmin) so the event is no longer Open.
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11.5));
    await expect(oracle.connect(signers.oracleA).submitRate(eventId, rate(11.5)))
      .to.be.revertedWith("Event not open");
  });
});

describe("OracleFacet — consensus engine", function () {
  it("averages two in-tolerance prices and settles at the mean", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    const eventId = await settleableEvent(hedge, signers);

    // 11.50 vs 11.55 → spread = 50000×10000/11_500_000 ≈ 43 bps < 100 bps tolerance.
    await oracle.connect(signers.oracleA).submitRate(eventId, rate(11.5));
    await expect(oracle.connect(signers.oracleB).submitRate(eventId, rate(11.55)))
      .to.emit(oracle, "ConsensusReached")
      .and.to.emit(oracle, "OracleEventSettled");

    const stats = await hedge.getHedgeEventStats(eventId);
    const core = await hedge.getHedgeEventCore(eventId);
    expect(core.status).to.equal(HedgeStatus.Settled);
    // mean = (11_500_000 + 11_550_000) / 2 = 11_525_000
    expect(stats.settlementPrice).to.equal(11_525_000n);
    expect(stats.triggered).to.equal(true);
    // Submitters cleared after settlement.
    expect(await oracle.getSubmitterCount(eventId)).to.equal(0n);
  });

  it("a single fresh submission below requiredSigners does not settle", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    const eventId = await settleableEvent(hedge, signers);
    await oracle.connect(signers.oracleA).submitRate(eventId, rate(11.5));
    expect((await hedge.getHedgeEventCore(eventId)).status).to.equal(HedgeStatus.Open);
    expect(await oracle.getSubmitterCount(eventId)).to.equal(1n);
  });

  it("excludes stale submissions from the consensus count", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    const eventId = await settleableEvent(hedge, signers);

    await oracle.connect(signers.oracleA).submitRate(eventId, rate(11.5));
    // Let A's submission go stale (> 15 min old).
    await time.increase(STALE_THRESHOLD + 1);
    // B submits fresh. Now A is stale → only 1 valid submission < requiredSigners → no settle.
    await oracle.connect(signers.oracleB).submitRate(eventId, rate(11.5));
    expect((await hedge.getHedgeEventCore(eventId)).status).to.equal(HedgeStatus.Open);

    // A resubmits fresh (cooldown of 5 min already elapsed). Now A + B both fresh → settle.
    await oracle.connect(signers.oracleA).submitRate(eventId, rate(11.5));
    expect((await hedge.getHedgeEventCore(eventId)).status).to.equal(HedgeStatus.Settled);
  });

  it("getSubmission reports the staleness flag correctly", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    const eventId = await settleableEvent(hedge, signers);
    await oracle.connect(signers.oracleA).submitRate(eventId, rate(11.5));

    let sub = await oracle.getSubmission(eventId, signers.oracleA.address);
    expect(sub.exists).to.equal(true);
    expect(sub.price).to.equal(rate(11.5));
    expect(sub.isStale).to.equal(false);

    await time.increase(STALE_THRESHOLD + 1);
    sub = await oracle.getSubmission(eventId, signers.oracleA.address);
    expect(sub.isStale).to.equal(true);
  });

  it("getAllSubmissions returns parallel arrays for every submitter", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB, signers.oracleC], 3);
    const eventId = await settleableEvent(hedge, signers);
    await oracle.connect(signers.oracleA).submitRate(eventId, rate(11.5));
    await oracle.connect(signers.oracleB).submitRate(eventId, rate(11.5));

    const all = await oracle.getAllSubmissions(eventId);
    expect(all.oracleAddresses.length).to.equal(2);
    expect(all.prices[0]).to.equal(rate(11.5));
    expect(all.isStale[0]).to.equal(false);
  });
});

describe("OracleFacet.clearStaleSubmissions — guards", function () {
  it("only owner", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    const eventId = await settleableEvent(hedge, signers);
    await oracle.connect(signers.oracleA).submitRate(eventId, rate(11.5));
    await expect(oracle.connect(signers.stranger).clearStaleSubmissions(eventId))
      .to.be.revertedWith("Not owner");
  });

  it("reverts for unknown event", async function () {
    const { oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    await expect(oracle.connect(signers.owner).clearStaleSubmissions(999n))
      .to.be.revertedWith("Event not found");
  });

  it("reverts when there are no submissions to clear", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    const eventId = await settleableEvent(hedge, signers);
    await expect(oracle.connect(signers.owner).clearStaleSubmissions(eventId))
      .to.be.revertedWith("No submissions to clear");
  });

  it("reverts when the event is already settled", async function () {
    const { hedge, oracle, signers } = await loadFixture(deployDiamondFixture);
    await registerOracles(oracle, signers.owner, [signers.oracleA, signers.oracleB], 2);
    const eventId = await settleableEvent(hedge, signers);
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11.5));
    await expect(oracle.connect(signers.owner).clearStaleSubmissions(eventId))
      .to.be.revertedWith("Event already settled");
  });
});
