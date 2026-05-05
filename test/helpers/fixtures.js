/**
 * fixtures.js — Reusable Diamond deployment for tests.
 *
 * Usage:
 *   const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
 *   const { deployDiamondFixture } = require("../helpers/fixtures");
 *   ...
 *   const ctx = await loadFixture(deployDiamondFixture);
 *
 * `loadFixture` snapshots the chain after the first run and rewinds for every subsequent
 * test, so deployment cost is paid once across the whole suite.
 */

const hre = require("hardhat");
const { ethers } = hre;

// --- Constants mirroring the contract's own ----------------------------------
const PRECISION = 10n ** 6n;          // 1e6 — fee/percentage denominator
const USDC_DECIMALS = 6;              // payment token decimals
const ONE_USDC = 10n ** BigInt(USDC_DECIMALS); // 1 USDC in raw units

// Default fee config used in tests. Mirrors the Lisk/Base mainnet default in deploy-diamond.js.
const DEFAULT_FEES = {
  eventCreationFee:    25n * ONE_USDC, // $25
  hedgerFeeRate:        5_000n,        // 0.5%
  hedgerPayoutFeeRate: 10_000n,        // 1%
  lpProfitFeeRate:     10_000n,        // 1%
  creatorLoyaltyRate:  50_000n,        // 5%
};

// Helper: convert a human dollar amount (number or bigint) into USDC raw units.
const usd = (n) => BigInt(n) * ONE_USDC;

// Helper: convert a human FX rate (e.g. 10.5) into 6-decimal fixed point.
//   rate(10)     = 10_000_000n
//   rate(10.5)   = 10_500_000n
//   rate(11.25)  = 11_250_000n
function rate(value) {
  const [whole, frac = ""] = String(value).split(".");
  const padded = (frac + "000000").slice(0, 6);
  return BigInt(whole) * ONE_USDC + BigInt(padded || "0");
}

// Pre-compute every selector exposed by a facet for diamondCut().
function getSelectors(contract) {
  return contract.interface.fragments
    .filter(f => f.type === "function")
    .map(f => contract.interface.getFunction(f.name).selector);
}

/**
 * Full Diamond deployment + initial fees + USDC funded test wallets.
 *
 * Returns:
 *   - signers: { owner, oracleAdmin, creator, lp1, lp2, lp3, hedger1, hedger2, hedger3, oracleA, oracleB, oracleC, stranger }
 *   - usdc: MockERC20 (6 decimals, every test wallet pre-funded with 1,000,000 USDC and pre-approved on the Diamond)
 *   - diamond: BlockFinaXDiamond contract
 *   - hedge: HedgeFacet ABI bound to the Diamond address
 *   - oracle: OracleFacet ABI bound to the Diamond address
 *   - loupe: DiamondLoupeFacet ABI bound to the Diamond address
 *   - addresses: { diamond, hedgeFacet, oracleFacet, loupeFacet, cutFacet, usdc }
 */
async function deployDiamondFixture() {
  const allSigners = await ethers.getSigners();
  const [
    owner, oracleAdmin, creator, lp1, lp2, lp3,
    hedger1, hedger2, hedger3,
    oracleA, oracleB, oracleC,
    stranger,
  ] = allSigners;

  // 1. Mock USDC (6 decimals).
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
  await usdc.waitForDeployment();

  // 2. DiamondCutFacet (used during construction to register all other facets).
  const CutFacet = await ethers.getContractFactory("BlockFinaXDiamondCutFacet");
  const cutFacet = await CutFacet.deploy();
  await cutFacet.waitForDeployment();

  // 3. Diamond proxy.
  const Diamond = await ethers.getContractFactory("BlockFinaXDiamond");
  const diamond = await Diamond.deploy(
    owner.address,
    await cutFacet.getAddress(),
    await usdc.getAddress(),
  );
  await diamond.waitForDeployment();
  const diamondAddress = await diamond.getAddress();

  // 4. Loupe facet.
  const LoupeFacet = await ethers.getContractFactory("BlockFinaXDiamondLoupeFacet");
  const loupeFacet = await LoupeFacet.deploy();
  await loupeFacet.waitForDeployment();

  // 5. HedgeFacet (the v7 build).
  const HedgeFacet = await ethers.getContractFactory("BlockFinaXHedgeFacet");
  const hedgeFacet = await HedgeFacet.deploy();
  await hedgeFacet.waitForDeployment();

  // 6. OracleFacet (multi-signer settlement).
  const OracleFacet = await ethers.getContractFactory("BlockFinaXOracleFacet");
  const oracleFacet = await OracleFacet.deploy();
  await oracleFacet.waitForDeployment();

  // 7. Add all three to the Diamond in one cut.
  const diamondCutContract = await ethers.getContractAt("BlockFinaXDiamondCutFacet", diamondAddress);
  await diamondCutContract.connect(owner).diamondCut(
    [
      { facetAddress: await loupeFacet.getAddress(),  action: 0, functionSelectors: getSelectors(loupeFacet)  },
      { facetAddress: await hedgeFacet.getAddress(),  action: 0, functionSelectors: getSelectors(hedgeFacet)  },
      { facetAddress: await oracleFacet.getAddress(), action: 0, functionSelectors: getSelectors(oracleFacet) },
    ],
    ethers.ZeroAddress,
    "0x",
  );

  // 8. Bind ABIs to the Diamond address.
  const hedge  = await ethers.getContractAt("BlockFinaXHedgeFacet",  diamondAddress);
  const oracle = await ethers.getContractAt("BlockFinaXOracleFacet", diamondAddress);
  const loupe  = await ethers.getContractAt("BlockFinaXDiamondLoupeFacet", diamondAddress);

  // 9. Initialise hedge fees (required before createEvent).
  await hedge.connect(owner).initializeHedgeFees(
    DEFAULT_FEES.eventCreationFee,
    DEFAULT_FEES.hedgerFeeRate,
    DEFAULT_FEES.hedgerPayoutFeeRate,
    DEFAULT_FEES.lpProfitFeeRate,
    DEFAULT_FEES.creatorLoyaltyRate,
  );

  // 10. Set the single-key oracle admin (tests use this path unless they switch to OracleFacet).
  await hedge.connect(owner).setOracleAdmin(oracleAdmin.address);

  // 11. Fund every test wallet with 1,000,000 USDC and pre-approve the Diamond.
  const fundedWallets = [creator, lp1, lp2, lp3, hedger1, hedger2, hedger3, stranger];
  const fundAmount = 1_000_000n * ONE_USDC;
  for (const w of fundedWallets) {
    await usdc.mint(w.address, fundAmount);
    await usdc.connect(w).approve(diamondAddress, ethers.MaxUint256);
  }

  return {
    signers: {
      owner, oracleAdmin, creator, lp1, lp2, lp3,
      hedger1, hedger2, hedger3,
      oracleA, oracleB, oracleC,
      stranger,
    },
    usdc,
    diamond,
    hedge,
    oracle,
    loupe,
    addresses: {
      diamond:      diamondAddress,
      hedgeFacet:   await hedgeFacet.getAddress(),
      oracleFacet:  await oracleFacet.getAddress(),
      loupeFacet:   await loupeFacet.getAddress(),
      cutFacet:     await cutFacet.getAddress(),
      usdc:         await usdc.getAddress(),
    },
    constants: {
      PRECISION,
      ONE_USDC,
      USDC_DECIMALS,
      DEFAULT_FEES,
    },
  };
}

/**
 * Build a CreateEventParams object with sensible defaults for a USD/GHS upward range hedge.
 * Override any field by passing it in `overrides`.
 *
 * Defaults: initialRate=10, strike=11, payoutCap=12 → 10% range from spot, $1-per-$10 max payout.
 */
function buildEventParams(overrides = {}) {
  const oneHour = 60 * 60;
  const defaults = {
    name:              "USD/GHS Range Hedge",
    underlying:        "USD/GHS",
    strike:            rate(11),               // entry threshold
    payoutCap:         rate(12),               // far edge of range (set to 0n for legacy single-strike)
    premiumRate:       25_000n,                // 2.5%
    expiryDate:        Math.floor(Date.now() / 1000) + 30 * 24 * oneHour, // 30 days
    allowExternalLp:   true,
    initialLiquidity:  10_000n * ONE_USDC,     // $10,000
    initialRate:       rate(10),               // current spot
    strikeAbove:       true,                   // upward hedge
    paymentToken:      ethers.ZeroAddress,     // = default usdcToken

    // ── v8 signature fields ─────────────────────────────────────────────
    // Default to empty values, valid only when the Diamond's pricingEngineSigner
    // is unset (legacy mode). Tests that exercise the signed-quote path should
    // override these via signEventParams() in test/helpers/signQuote.js.
    signature:         "0x",
    quoteTimestamp:    0n,
    quoteNonce:        ethers.ZeroHash,
  };
  return { ...defaults, ...overrides };
}

/**
 * After createEvent the pool is closed; this helper opens it for hedging.
 */
async function openPool(hedge, creator, eventId, allowExternalLp = true) {
  await hedge.connect(creator).setPoolSettings(eventId, true, allowExternalLp);
}

/**
 * Generate a random pricing-engine signer wallet AND register it on the Diamond.
 * Returns the wallet so tests can use it to sign quotes.
 *
 * Use this to opt INTO signature-required mode for a test. Tests that don't call
 * this stay in legacy mode (signer = address(0), createEvent accepts unsigned params).
 */
async function setupPricingEngineSigner(hedge, owner) {
  const signerWallet = ethers.Wallet.createRandom();
  await hedge.connect(owner).setPricingEngineSigner(signerWallet.address);
  return signerWallet;
}

module.exports = {
  deployDiamondFixture,
  buildEventParams,
  openPool,
  setupPricingEngineSigner,
  getSelectors,
  PRECISION,
  ONE_USDC,
  USDC_DECIMALS,
  DEFAULT_FEES,
  usd,
  rate,
};
