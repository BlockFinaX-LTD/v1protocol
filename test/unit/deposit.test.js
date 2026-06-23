/**
 * deposit.test.js — LP deposit() and setPoolSettings() — every branch.
 *
 * deposit() covers:
 *   - share math for the first (creator) and subsequent LP deposits (Balancer-style)
 *   - min deposit (10 USDC) guard
 *   - event-not-found / event-not-open guards
 *   - access: external LP needs BOTH poolOpen AND allowExternalLp; creator can always deposit
 *   - MAX_DEPOSITS_PER_EVENT (200) cap
 *   - token transfer + reserve accounting
 *   - LiquidityDeposited event
 *
 * setPoolSettings() covers:
 *   - only creator; event must exist and still be Open
 *   - toggles poolOpen / allowExternalLp and emits PoolSettingsUpdated
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
const SHARES_PRECISION = 10n ** 18n;
const PRECISION = 10n ** 6n;

async function makeEvent(hedge, signers, overrides = {}) {
  await hedge.connect(signers.creator).createEvent(buildEventParams(overrides));
  return hedge.getTotalHedgeEvents();
}

describe("HedgeFacet.deposit — share math", function () {
  it("first (creator) deposit mints shares = amount × 1e18 / 1e6", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeEvent(hedge, signers, { initialLiquidity: 1_000n * ONE_USDC });
    const depId = (await hedge.getEventDepositIds(eventId))[0];
    const dep = await hedge.getHedgeLpDeposit(depId);
    expect(dep.shares).to.equal((1_000n * ONE_USDC * SHARES_PRECISION) / PRECISION);
  });

  it("second LP deposit mints shares proportional to existing pool", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    // Creator seeds $10K. totalActiveShares = 10_000e6 × 1e12. totalLiquidity = 10_000e6.
    const eventId = await makeEvent(hedge, signers, { initialLiquidity: 10_000n * ONE_USDC });
    await openPool(hedge, signers.creator, eventId);

    await hedge.connect(signers.lp1).deposit(eventId, 5_000n * ONE_USDC);
    const lp1DepId = (await hedge.getLpDepositIds(signers.lp1.address))[0];
    const dep = await hedge.getHedgeLpDeposit(lp1DepId);

    // shares = amount × totalActiveShares / totalLiquidity
    //        = 5_000e6 × (10_000e6 × 1e12) / 10_000e6 = 5_000e6 × 1e12
    expect(dep.shares).to.equal(5_000n * ONE_USDC * 10n ** 12n);
    expect(dep.amount).to.equal(5_000n * ONE_USDC);
    expect(dep.lp).to.equal(signers.lp1.address);
  });

  it("updates totalLiquidity and lpCount and emits LiquidityDeposited", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeEvent(hedge, signers, { initialLiquidity: 10_000n * ONE_USDC });
    await openPool(hedge, signers.creator, eventId);

    await expect(hedge.connect(signers.lp1).deposit(eventId, 5_000n * ONE_USDC))
      .to.emit(hedge, "LiquidityDeposited");

    const stats = await hedge.getHedgeEventStats(eventId);
    expect(stats.totalLiquidity).to.equal(15_000n * ONE_USDC);
    expect(stats.lpCount).to.equal(2n); // creator + lp1
  });

  it("moves USDC from the LP into the Diamond", async function () {
    const { hedge, signers, usdc, addresses } = await loadFixture(deployDiamondFixture);
    const eventId = await makeEvent(hedge, signers, { initialLiquidity: 10_000n * ONE_USDC });
    await openPool(hedge, signers.creator, eventId);

    const lpBefore = await usdc.balanceOf(signers.lp1.address);
    const diamondBefore = await usdc.balanceOf(addresses.diamond);
    await hedge.connect(signers.lp1).deposit(eventId, 5_000n * ONE_USDC);
    expect(lpBefore - await usdc.balanceOf(signers.lp1.address)).to.equal(5_000n * ONE_USDC);
    expect(await usdc.balanceOf(addresses.diamond) - diamondBefore).to.equal(5_000n * ONE_USDC);
  });
});

describe("HedgeFacet.deposit — guards", function () {
  it("reverts for an unknown event", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.lp1).deposit(999n, 100n * ONE_USDC))
      .to.be.revertedWith("Event not found");
  });

  it("reverts when amount below 10 USDC minimum", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeEvent(hedge, signers);
    await openPool(hedge, signers.creator, eventId);
    await expect(hedge.connect(signers.lp1).deposit(eventId, 9n * ONE_USDC))
      .to.be.revertedWith("Min deposit: 10 USDC");
  });

  it("reverts when the event is no longer Open (settled)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeEvent(hedge, signers);
    await openPool(hedge, signers.creator, eventId);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await warpPastExpiry(hedge, eventId);
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11.5));
    await expect(hedge.connect(signers.lp1).deposit(eventId, 100n * ONE_USDC))
      .to.be.revertedWith("Event not open");
  });
});

describe("HedgeFacet.deposit — access control", function () {
  it("external LP cannot deposit while the pool is closed (poolOpen = false)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeEvent(hedge, signers); // pool starts closed
    await expect(hedge.connect(signers.lp1).deposit(eventId, 100n * ONE_USDC))
      .to.be.revertedWith("Pool closed to external LPs");
  });

  it("external LP cannot deposit when allowExternalLp = false even if poolOpen", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeEvent(hedge, signers);
    await hedge.connect(signers.creator).setPoolSettings(eventId, true, false); // open to hedgers, not external LPs
    await expect(hedge.connect(signers.lp1).deposit(eventId, 100n * ONE_USDC))
      .to.be.revertedWith("Pool closed to external LPs");
  });

  it("external LP CAN deposit once poolOpen && allowExternalLp", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeEvent(hedge, signers);
    await hedge.connect(signers.creator).setPoolSettings(eventId, true, true);
    await expect(hedge.connect(signers.lp1).deposit(eventId, 100n * ONE_USDC)).to.not.be.reverted;
  });

  it("creator can always deposit, even while the pool is closed", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeEvent(hedge, signers); // closed
    // Creator seeds extra liquidity before opening to hedgers.
    await expect(hedge.connect(signers.creator).deposit(eventId, 1_000n * ONE_USDC)).to.not.be.reverted;
    const stats = await hedge.getHedgeEventStats(eventId);
    expect(stats.totalLiquidity).to.equal(11_000n * ONE_USDC); // 10K initial + 1K
  });
});

describe("HedgeFacet.deposit — MAX_DEPOSITS_PER_EVENT cap (200)", function () {
  it("rejects the 201st deposit", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    // Creator's initial deposit counts as #1. Add 199 more to reach 200, then the next reverts.
    const eventId = await makeEvent(hedge, signers, { initialLiquidity: 10_000n * ONE_USDC });
    await openPool(hedge, signers.creator, eventId);

    for (let i = 0; i < 199; i++) {
      await hedge.connect(signers.lp1).deposit(eventId, 10n * ONE_USDC);
    }
    // Now 200 deposits exist → next must revert.
    await expect(hedge.connect(signers.lp1).deposit(eventId, 10n * ONE_USDC))
      .to.be.revertedWith("Max LP deposits reached for this event");
  });
});

describe("HedgeFacet.setPoolSettings", function () {
  it("only the creator can change settings", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeEvent(hedge, signers);
    await expect(hedge.connect(signers.stranger).setPoolSettings(eventId, true, true))
      .to.be.revertedWith("Not creator");
  });

  it("reverts for an unknown event", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    await expect(hedge.connect(signers.creator).setPoolSettings(999n, true, true))
      .to.be.revertedWith("Event not found");
  });

  it("reverts once the event is settled (not Open)", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeEvent(hedge, signers);
    await openPool(hedge, signers.creator, eventId);
    await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
    await warpPastExpiry(hedge, eventId);
    await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11.5));
    await expect(hedge.connect(signers.creator).setPoolSettings(eventId, false, false))
      .to.be.revertedWith("Event not open");
  });

  it("toggles flags and emits PoolSettingsUpdated", async function () {
    const { hedge, signers } = await loadFixture(deployDiamondFixture);
    const eventId = await makeEvent(hedge, signers);
    await expect(hedge.connect(signers.creator).setPoolSettings(eventId, true, false))
      .to.emit(hedge, "PoolSettingsUpdated").withArgs(eventId, true, false);
    const core = await hedge.getHedgeEventCore(eventId);
    expect(core.poolOpen).to.equal(true);
    expect(core.allowExternalLp).to.equal(false);
  });
});
