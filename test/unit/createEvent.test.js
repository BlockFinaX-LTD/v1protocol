/**
 * createEvent.test.js — every validation branch in createEvent for both product modes.
 *
 * Covers:
 *   - happy paths for range mode and single-strike mode
 *   - all input-validation reverts
 *   - direction checks (strikeAbove ↔ strike vs initialRate, payoutCap vs strike)
 *   - 10x payout cap (range-width form and single-strike form)
 *   - fee-not-initialised guard (separate fixture without init)
 *   - storage population (HedgeEvent fields written correctly)
 */

const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { ethers } = require("hardhat");
const {
  deployDiamondFixture,
  buildEventParams,
  rate,
  ONE_USDC,
} = require("../helpers/fixtures");

describe("HedgeFacet.createEvent — validation", function () {

  describe("happy path", function () {
    it("creates a v7 range event and persists every field", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      const params = buildEventParams();

      const tx = await hedge.connect(signers.creator).createEvent(params);
      await tx.wait();

      const eventId = await hedge.getTotalHedgeEvents();
      expect(eventId).to.equal(1n);

      const core = await hedge.getHedgeEventCore(eventId);
      expect(core.creator).to.equal(signers.creator.address);
      expect(core.strike).to.equal(rate(11));
      expect(core.premiumRate).to.equal(25_000n);
      expect(core.strikeAbove).to.equal(true);
      expect(core.initialRate).to.equal(rate(10));
      expect(core.poolOpen).to.equal(false); // pool starts closed

      const range = await hedge.getHedgeEventRange(eventId);
      expect(range.payoutCap).to.equal(rate(12));
      expect(range.strike).to.equal(rate(11));
      expect(range.strikeAbove).to.equal(true);
    });

    it("creates a single-strike (legacy) event when payoutCap = 0", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      const params = buildEventParams({ payoutCap: 0n });

      await hedge.connect(signers.creator).createEvent(params);
      const eventId = await hedge.getTotalHedgeEvents();
      const range = await hedge.getHedgeEventRange(eventId);
      expect(range.payoutCap).to.equal(0n);
    });

    it("creates a downward range hedge (strike < initialRate, payoutCap < strike)", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      const params = buildEventParams({
        strikeAbove: false,
        strike:      rate(9),
        payoutCap:   rate(8),
      });
      await hedge.connect(signers.creator).createEvent(params);
      const range = await hedge.getHedgeEventRange(await hedge.getTotalHedgeEvents());
      expect(range.strike).to.equal(rate(9));
      expect(range.payoutCap).to.equal(rate(8));
      expect(range.strikeAbove).to.equal(false);
    });
  });

  describe("input validation reverts", function () {
    it("rejects empty name", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({ name: "" })))
        .to.be.revertedWith("Name required");
    });

    it("rejects name longer than 128 bytes", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      const longName = "a".repeat(129);
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({ name: longName })))
        .to.be.revertedWith("Name too long (max 128 bytes)");
    });

    it("rejects empty underlying", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({ underlying: "" })))
        .to.be.revertedWith("Underlying required");
    });

    it("rejects strike == 0", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({ strike: 0n })))
        .to.be.revertedWith("Strike must be > 0");
    });

    it("rejects premiumRate == 0", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({ premiumRate: 0n })))
        .to.be.revertedWith("Premium rate must be > 0");
    });

    it("rejects premiumRate above 100% (PRECISION)", async function () {
      const { hedge, signers, constants } = await loadFixture(deployDiamondFixture);
      const overcap = constants.PRECISION + 1n;
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({ premiumRate: overcap })))
        .to.be.revertedWith("Premium rate cannot exceed 100%");
    });

    it("rejects expiry in the past", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({ expiryDate: 1 })))
        .to.be.revertedWith("Expiry must be in future");
    });

    it("rejects expiry more than 365 days out", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      const tooFar = Math.floor(Date.now() / 1000) + 366 * 24 * 60 * 60;
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({ expiryDate: tooFar })))
        .to.be.revertedWith("Expiry cannot exceed 365 days from now");
    });

    it("rejects initialLiquidity below 10 USDC", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({ initialLiquidity: 9n * ONE_USDC })))
        .to.be.revertedWith("Min initial liquidity: 10 USDC");
    });

    it("rejects initialRate == 0", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({ initialRate: 0n })))
        .to.be.revertedWith("Initial rate must be > 0");
    });
  });

  describe("upward hedge direction checks", function () {
    it("rejects strike <= initialRate for upward", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({
        strikeAbove: true, strike: rate(10), payoutCap: rate(11),
      }))).to.be.revertedWith("Strike must be above current rate for upward hedge");
    });

    it("rejects payoutCap <= strike for upward range", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({
        strikeAbove: true, strike: rate(11), payoutCap: rate(11),
      }))).to.be.revertedWith("payoutCap must be above strike for upward hedge");
    });

    it("accepts a deep-OTM strike if range width is within bounds", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      // strike 5x spot, range only 1x spot wide — allowed.
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({
        strikeAbove: true, initialRate: rate(10), strike: rate(50), payoutCap: rate(60),
      }))).to.not.be.reverted;
    });
  });

  describe("downward hedge direction checks", function () {
    it("rejects strike >= initialRate for downward", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({
        strikeAbove: false, strike: rate(10), payoutCap: rate(9),
      }))).to.be.revertedWith("Strike must be below current rate for downward hedge");
    });

    it("rejects payoutCap >= strike for downward range", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({
        strikeAbove: false, strike: rate(9), payoutCap: rate(9),
      }))).to.be.revertedWith("payoutCap must be below strike for downward hedge");
    });
  });

  describe("M-02 — 10x per-notional payout cap", function () {
    it("range mode: rejects rangeWidth > 10x initialRate", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      // initialRate = 10, range width must be ≤ 100. Set width = 101 → reject.
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({
        initialRate: rate(10), strike: rate(11), payoutCap: rate(112),
      }))).to.be.revertedWith("Payout range too wide: max payout per notional is 10x");
    });

    it("range mode: accepts rangeWidth exactly equal to 10x initialRate", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      // strike 11, payoutCap 111 → width 100 = exactly 10x initialRate(10).
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({
        initialRate: rate(10), strike: rate(11), payoutCap: rate(111),
      }))).to.not.be.reverted;
    });

    it("single-strike mode: rejects |strike - initialRate| > 10x initialRate", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      // initialRate=10, strike=110 → priceDelta=100=10x; strike=111 → 101 over.
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({
        payoutCap: 0n, initialRate: rate(10), strike: rate(111),
      }))).to.be.revertedWith("Strike too far from initial rate: max payout per notional is 10x");
    });

    it("single-strike mode: accepts |strike - initialRate| exactly 10x", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      await expect(hedge.connect(signers.creator).createEvent(buildEventParams({
        payoutCap: 0n, initialRate: rate(10), strike: rate(110),
      }))).to.not.be.reverted;
    });
  });

  describe("payment token validation", function () {
    it("falls back to default usdcToken when paymentToken == address(0)", async function () {
      const { hedge, addresses, signers } = await loadFixture(deployDiamondFixture);
      await hedge.connect(signers.creator).createEvent(buildEventParams({ paymentToken: ethers.ZeroAddress }));
      const tokenAddr = await hedge.getEventPaymentToken(await hedge.getTotalHedgeEvents());
      expect(tokenAddr).to.equal(addresses.usdc);
    });

    it("rejects non-whitelisted custom payment token", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      // Deploy an unrelated token; not whitelisted.
      const Mock = await ethers.getContractFactory("MockERC20");
      const usdt = await Mock.deploy("Tether", "USDT", 6);
      await usdt.waitForDeployment();
      await expect(hedge.connect(signers.creator).createEvent(
        buildEventParams({ paymentToken: await usdt.getAddress() })
      )).to.be.revertedWith("Payment token not whitelisted");
    });

    it("accepts a token after whitelisting", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      const Mock = await ethers.getContractFactory("MockERC20");
      const usdt = await Mock.deploy("Tether", "USDT", 6);
      await usdt.waitForDeployment();
      const usdtAddr = await usdt.getAddress();

      await hedge.connect(signers.owner).setAllowedPaymentToken(usdtAddr, true);
      await usdt.mint(signers.creator.address, 100_000n * ONE_USDC);
      await usdt.connect(signers.creator).approve(await hedge.getAddress(), ethers.MaxUint256);

      await expect(hedge.connect(signers.creator).createEvent(
        buildEventParams({ paymentToken: usdtAddr })
      )).to.not.be.reverted;
    });
  });

  describe("creator-side accounting", function () {
    it("registers the event ID under the creator", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      await hedge.connect(signers.creator).createEvent(buildEventParams());
      const ids = await hedge.getCreatorEventIds(signers.creator.address);
      expect(ids.length).to.equal(1);
      expect(ids[0]).to.equal(1n);
    });

    it("snapshots fee rates from the global config at creation time", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      await hedge.connect(signers.creator).createEvent(buildEventParams());
      // Owner changes fees AFTER event is created.
      await hedge.connect(signers.owner).initializeHedgeFees(0n, 1_000n, 1_000n, 1_000n, 1_000n);
      // The event's snapshot must still be the original 0.5%/1%/1%/5% values.
      // Probe indirectly through buyProtection math in the buyProtection tests; here we just
      // confirm the change didn't blow up and feesInitialized is still true.
      expect(await hedge.isFeesInitialized()).to.equal(true);
    });

    it("creates the creator's initial deposit with shares = amount × 1e12", async function () {
      const { hedge, signers, constants } = await loadFixture(deployDiamondFixture);
      await hedge.connect(signers.creator).createEvent(buildEventParams({
        initialLiquidity: 1_000n * ONE_USDC,
      }));
      const eventId = await hedge.getTotalHedgeEvents();
      const depositIds = await hedge.getEventDepositIds(eventId);
      expect(depositIds.length).to.equal(1);
      const dep = await hedge.getHedgeLpDeposit(depositIds[0]);
      // First deposit: shares = amount × SHARES_PRECISION (1e18) / PRECISION (1e6) = amount × 1e12
      expect(dep.shares).to.equal(1_000n * ONE_USDC * 10n ** 12n);
      expect(dep.lp).to.equal(signers.creator.address);
    });

    it("transfers creationFee + initialLiquidity from the creator", async function () {
      const { hedge, signers, usdc, constants, addresses } = await loadFixture(deployDiamondFixture);
      const liquidity = 5_000n * ONE_USDC;
      const balBefore = await usdc.balanceOf(signers.creator.address);
      const diamondBefore = await usdc.balanceOf(addresses.diamond);

      await hedge.connect(signers.creator).createEvent(buildEventParams({ initialLiquidity: liquidity }));

      const expectedSpent = constants.DEFAULT_FEES.eventCreationFee + liquidity;
      expect(await usdc.balanceOf(signers.creator.address)).to.equal(balBefore - expectedSpent);
      expect(await usdc.balanceOf(addresses.diamond)).to.equal(diamondBefore + expectedSpent);
    });
  });
});

describe("HedgeFacet.createEvent — fees not initialised", function () {
  it("reverts when initializeHedgeFees has never been called", async function () {
    // Bypass the fixture and deploy a fresh Diamond WITHOUT initialising fees.
    const [owner, creator] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockERC20");
    const usdc = await Mock.deploy("USDC", "USDC", 6);
    await usdc.waitForDeployment();

    const Cut = await ethers.getContractFactory("BlockFinaXDiamondCutFacet");
    const cut = await Cut.deploy(); await cut.waitForDeployment();

    const Diamond = await ethers.getContractFactory("BlockFinaXDiamond");
    const diamond = await Diamond.deploy(owner.address, await cut.getAddress(), await usdc.getAddress());
    await diamond.waitForDeployment();
    const dAddr = await diamond.getAddress();

    const Hedge = await ethers.getContractFactory("BlockFinaXHedgeFacet");
    const hedgeImpl = await Hedge.deploy(); await hedgeImpl.waitForDeployment();

    const { getSelectors } = require("../helpers/fixtures");
    const cutContract = await ethers.getContractAt("BlockFinaXDiamondCutFacet", dAddr);
    await cutContract.connect(owner).diamondCut(
      [{ facetAddress: await hedgeImpl.getAddress(), action: 0, functionSelectors: getSelectors(hedgeImpl) }],
      ethers.ZeroAddress,
      "0x",
    );

    await usdc.mint(creator.address, 1_000_000n * ONE_USDC);
    await usdc.connect(creator).approve(dAddr, ethers.MaxUint256);

    const hedge = await ethers.getContractAt("BlockFinaXHedgeFacet", dAddr);
    await expect(hedge.connect(creator).createEvent(buildEventParams()))
      .to.be.revertedWith("Fees not initialized: call initializeHedgeFees first");
  });
});
