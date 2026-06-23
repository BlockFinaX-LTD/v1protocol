/**
 * multiToken.test.js — multi-payment-token (USDT alongside USDC) end-to-end lifecycle.
 *
 * Setup:
 *   - Default fixture wires USDC (6 decimals) as the protocol payment token.
 *   - Owner whitelists a second token (USDT, also 6 decimals) via setAllowedPaymentToken.
 *   - Two events created in parallel: one denominated in USDC, one in USDT.
 *
 * Asserts:
 *   - Creator can choose USDT as payment token at createEvent
 *   - All deposits, premiums, payouts on a USDT event flow in USDT only
 *   - platformFeesByToken[USDT] accumulates separately from platformFeesByToken[USDC]
 *   - Owner can withdrawPlatformFeesByToken(USDT) → receives USDT, not USDC
 *   - The two events are economically isolated — USDT activity never touches the USDC
 *     pool / fees / reserves
 *   - rescueERC20 is blocked for the whitelisted USDT token
 *
 * Note: BSC USDT is actually 18-decimal in production; this test uses 6 to keep the
 * arithmetic identical to USDC for clarity. The contract handles either as long as
 * the chosen unit is consistent for that event.
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
const ONE_USDT = ONE_USDC; // both 6-decimal in this test

async function setupMultiToken() {
  const ctx = await loadFixture(deployDiamondFixture);
  const { signers, addresses, hedge } = ctx;

  // Deploy USDT mock and whitelist it as a valid payment token.
  const Mock = await ethers.getContractFactory("MockERC20");
  const usdt = await Mock.deploy("Tether", "USDT", 6);
  await usdt.waitForDeployment();
  const usdtAddr = await usdt.getAddress();

  await hedge.connect(signers.owner).setAllowedPaymentToken(usdtAddr, true);

  // Mint USDT and pre-approve for every wallet that will use it.
  const fundedWallets = [signers.creator, signers.lp1, signers.lp2, signers.hedger1, signers.hedger2];
  const fundAmount = 1_000_000n * ONE_USDT;
  for (const w of fundedWallets) {
    await usdt.mint(w.address, fundAmount);
    await usdt.connect(w).approve(addresses.diamond, ethers.MaxUint256);
  }

  return { ...ctx, usdt, usdtAddr };
}

describe("E2E: multi-token (USDT alongside USDC) lifecycle", function () {

  describe("Whitelist", function () {
    it("isAllowedPaymentToken: default USDC is implicit, USDT requires explicit whitelist", async function () {
      const { hedge, addresses } = await loadFixture(deployDiamondFixture);
      // Default USDC is always allowed even without setAllowedPaymentToken.
      expect(await hedge.isAllowedPaymentToken(addresses.usdc)).to.equal(true);

      // A brand-new token isn't allowed until whitelisted.
      const Mock = await ethers.getContractFactory("MockERC20");
      const usdt = await Mock.deploy("Tether", "USDT", 6); await usdt.waitForDeployment();
      expect(await hedge.isAllowedPaymentToken(await usdt.getAddress())).to.equal(false);
    });

    it("setAllowedPaymentToken: only owner; emits PaymentTokenSet", async function () {
      const { hedge, signers } = await loadFixture(deployDiamondFixture);
      const Mock = await ethers.getContractFactory("MockERC20");
      const usdt = await Mock.deploy("Tether", "USDT", 6); await usdt.waitForDeployment();
      const usdtAddr = await usdt.getAddress();

      await expect(hedge.connect(signers.stranger).setAllowedPaymentToken(usdtAddr, true))
        .to.be.revertedWith("Not owner");

      await expect(hedge.connect(signers.owner).setAllowedPaymentToken(usdtAddr, true))
        .to.emit(hedge, "PaymentTokenSet").withArgs(usdtAddr, true);

      expect(await hedge.isAllowedPaymentToken(usdtAddr)).to.equal(true);

      // Removing also works.
      await hedge.connect(signers.owner).setAllowedPaymentToken(usdtAddr, false);
      expect(await hedge.isAllowedPaymentToken(usdtAddr)).to.equal(false);
    });
  });

  describe("USDT-denominated event", function () {
    it("createEvent uses USDT for the creation fee + initial deposit", async function () {
      const { hedge, signers, usdt, usdtAddr, addresses, usdc } = await setupMultiToken();

      const usdtCreatorBefore = await usdt.balanceOf(signers.creator.address);
      const usdcCreatorBefore = await usdc.balanceOf(signers.creator.address);

      await hedge.connect(signers.creator).createEvent(buildEventParams({
        paymentToken: usdtAddr,
        initialLiquidity: 5_000n * ONE_USDT,
      }));
      const eventId = await hedge.getTotalHedgeEvents();

      // Creator paid creationFee ($25) + $5K liquidity in USDT.
      expect(usdtCreatorBefore - await usdt.balanceOf(signers.creator.address)).to.equal(5_025n * ONE_USDT);
      // USDC balance untouched.
      expect(usdcCreatorBefore - await usdc.balanceOf(signers.creator.address)).to.equal(0n);

      // Event reports USDT as payment token.
      expect(await hedge.getEventPaymentToken(eventId)).to.equal(usdtAddr);
    });

    it("buyProtection / claimPayout / claimPremiums all flow in USDT", async function () {
      const { hedge, signers, usdt, usdtAddr, usdc, addresses } = await setupMultiToken();

      await hedge.connect(signers.creator).createEvent(buildEventParams({
        paymentToken: usdtAddr,
        initialLiquidity: 10_000n * ONE_USDT,
      }));
      const eventId = await hedge.getTotalHedgeEvents();
      await openPool(hedge, signers.creator, eventId);

      // Hedger pays in USDT only.
      const hUsdtBefore = await usdt.balanceOf(signers.hedger1.address);
      const hUsdcBefore = await usdc.balanceOf(signers.hedger1.address);
      await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDT, MAX_UINT, FAR_FUTURE);
      // Cost: 2.5% premium + 0.5% platform fee = 3% of $1K = $30 in USDT.
      expect(hUsdtBefore - await usdt.balanceOf(signers.hedger1.address)).to.equal(30n * ONE_USDT);
      expect(hUsdcBefore - await usdc.balanceOf(signers.hedger1.address)).to.equal(0n);

      // Settle in the money (range mid) — European: only at/after expiry.
      await warpPastExpiry(hedge, eventId);
      await hedge.connect(signers.oracleAdmin).settleEvent(eventId, rate(11.5));

      // Hedger claims — receives USDT.
      const positionId = (await hedge.getEventPositionIds(eventId))[0];
      const beforeClaimUsdt = await usdt.balanceOf(signers.hedger1.address);
      await hedge.connect(signers.hedger1).claimPayout(positionId);
      const afterClaimUsdt = await usdt.balanceOf(signers.hedger1.address);
      // $50 gross - 1% fee = $49.50 USDT.
      expect(afterClaimUsdt - beforeClaimUsdt).to.equal(49n * ONE_USDT + 500_000n);

      // Creator claims premiums — receives USDT.
      const cId = (await hedge.getLpDepositIds(signers.creator.address))[0];
      const beforePremUsdt = await usdt.balanceOf(signers.creator.address);
      await hedge.connect(signers.creator).claimPremiums(cId);
      expect(await usdt.balanceOf(signers.creator.address) - beforePremUsdt).to.be.gt(0n);
    });

    it("platform fees accumulate per token: getPlatformFeesByToken(USDT) tracks separately", async function () {
      const { hedge, signers, usdt, usdtAddr, addresses } = await setupMultiToken();

      await hedge.connect(signers.creator).createEvent(buildEventParams({
        paymentToken: usdtAddr,
        initialLiquidity: 10_000n * ONE_USDT,
      }));
      const eventId = await hedge.getTotalHedgeEvents();
      await openPool(hedge, signers.creator, eventId);

      // creationFee $25 + buyProtection platformFee $5 (0.5% × $1K) = $30 gross USDT fee.
      // Of the $5 buy fee, 5% creator-loyalty = $0.25 stays as creator earnings; net $4.75 platform.
      // Total accumulated USDT fees: $25 + $4.75 = $29.75.
      await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDT, MAX_UINT, FAR_FUTURE);

      const usdtFees = await hedge.getPlatformFeesByToken(usdtAddr);
      expect(usdtFees).to.equal(29n * ONE_USDT + 750_000n);

      // USDC fees are untouched (this protocol has only the USDT event).
      expect(await hedge.getPlatformFeesByToken(addresses.usdc)).to.equal(0n);
    });

    it("withdrawPlatformFeesByToken(USDT): owner receives USDT, not USDC", async function () {
      const { hedge, signers, usdt, usdtAddr, usdc, addresses } = await setupMultiToken();

      await hedge.connect(signers.creator).createEvent(buildEventParams({
        paymentToken: usdtAddr,
        initialLiquidity: 10_000n * ONE_USDT,
      }));
      const eventId = await hedge.getTotalHedgeEvents();
      await openPool(hedge, signers.creator, eventId);
      await hedge.connect(signers.hedger1).buyProtection(eventId, 1_000n * ONE_USDT, MAX_UINT, FAR_FUTURE);

      const fees = await hedge.getPlatformFeesByToken(usdtAddr);
      const ownerUsdtBefore = await usdt.balanceOf(signers.owner.address);
      const ownerUsdcBefore = await usdc.balanceOf(signers.owner.address);

      await hedge.connect(signers.owner).withdrawPlatformFeesByToken(usdtAddr, fees);

      expect(await usdt.balanceOf(signers.owner.address) - ownerUsdtBefore).to.equal(fees);
      expect(await usdc.balanceOf(signers.owner.address) - ownerUsdcBefore).to.equal(0n);
      expect(await hedge.getPlatformFeesByToken(usdtAddr)).to.equal(0n);
    });

    it("withdrawPlatformFeesByToken: only owner; rejects amount > available", async function () {
      const { hedge, signers, usdtAddr } = await setupMultiToken();
      await expect(hedge.connect(signers.stranger).withdrawPlatformFeesByToken(usdtAddr, 1n))
        .to.be.revertedWith("Not owner");
      await expect(hedge.connect(signers.owner).withdrawPlatformFeesByToken(usdtAddr, 1n))
        .to.be.revertedWith("Exceeds available fees for token");
      await expect(hedge.connect(signers.owner).withdrawPlatformFeesByToken(ethers.ZeroAddress, 1n))
        .to.be.revertedWith("Zero address");
    });
  });

  describe("Token isolation: USDC and USDT events run side-by-side", function () {
    it("activity on a USDT event does not move USDC reserves and vice versa", async function () {
      const { hedge, signers, usdt, usdtAddr, usdc, addresses } = await setupMultiToken();

      // Event A — USDC.
      await hedge.connect(signers.creator).createEvent(buildEventParams({
        initialLiquidity: 5_000n * ONE_USDC,
      }));
      const eventA = await hedge.getTotalHedgeEvents();
      await openPool(hedge, signers.creator, eventA);

      // Event B — USDT.
      await hedge.connect(signers.creator).createEvent(buildEventParams({
        paymentToken: usdtAddr,
        initialLiquidity: 5_000n * ONE_USDT,
      }));
      const eventB = await hedge.getTotalHedgeEvents();
      await openPool(hedge, signers.creator, eventB);

      // Hedge each event with a distinct hedger.
      await hedge.connect(signers.hedger1).buyProtection(eventA, 1_000n * ONE_USDC, MAX_UINT, FAR_FUTURE);
      await hedge.connect(signers.hedger2).buyProtection(eventB, 1_000n * ONE_USDT, MAX_UINT, FAR_FUTURE);

      // Settle and claim each at the same range-mid price (European: at/after expiry).
      await warpPastExpiry(hedge, eventB);
      await hedge.connect(signers.oracleAdmin).settleEvent(eventA, rate(11.5));
      await hedge.connect(signers.oracleAdmin).settleEvent(eventB, rate(11.5));

      const posA = (await hedge.getEventPositionIds(eventA))[0];
      const posB = (await hedge.getEventPositionIds(eventB))[0];

      // Hedger1 receives USDC only.
      const h1UsdtBefore = await usdt.balanceOf(signers.hedger1.address);
      const h1UsdcBefore = await usdc.balanceOf(signers.hedger1.address);
      await hedge.connect(signers.hedger1).claimPayout(posA);
      expect(await usdc.balanceOf(signers.hedger1.address) - h1UsdcBefore).to.equal(49n * ONE_USDC + 500_000n);
      expect(await usdt.balanceOf(signers.hedger1.address) - h1UsdtBefore).to.equal(0n);

      // Hedger2 receives USDT only.
      const h2UsdtBefore = await usdt.balanceOf(signers.hedger2.address);
      const h2UsdcBefore = await usdc.balanceOf(signers.hedger2.address);
      await hedge.connect(signers.hedger2).claimPayout(posB);
      expect(await usdt.balanceOf(signers.hedger2.address) - h2UsdtBefore).to.equal(49n * ONE_USDT + 500_000n);
      expect(await usdc.balanceOf(signers.hedger2.address) - h2UsdcBefore).to.equal(0n);

      // Per-token fee ledgers are independent and both non-zero.
      expect(await hedge.getPlatformFeesByToken(addresses.usdc)).to.be.gt(0n);
      expect(await hedge.getPlatformFeesByToken(usdtAddr)).to.be.gt(0n);
    });
  });

  describe("rescueERC20 protections", function () {
    it("cannot rescue a whitelisted alternate payment token even if not the default usdcToken", async function () {
      const { hedge, signers, usdtAddr } = await setupMultiToken();
      await expect(hedge.connect(signers.owner).rescueERC20(usdtAddr, signers.lp1.address))
        .to.be.revertedWith("Cannot rescue whitelisted payment token");
    });

    it("after de-whitelisting, USDT becomes rescuable again (admin operation, use with care)", async function () {
      const { hedge, signers, usdt, usdtAddr } = await setupMultiToken();
      // Airdrop some USDT to the Diamond directly (not via createEvent — pure donation).
      await usdt.mint(await hedge.getAddress(), 10n * ONE_USDT);
      // Remove from whitelist first.
      await hedge.connect(signers.owner).setAllowedPaymentToken(usdtAddr, false);
      // Now rescue is allowed.
      const balBefore = await usdt.balanceOf(signers.lp1.address);
      await hedge.connect(signers.owner).rescueERC20(usdtAddr, signers.lp1.address);
      expect(await usdt.balanceOf(signers.lp1.address) - balBefore).to.be.gt(0n);
    });
  });
});
