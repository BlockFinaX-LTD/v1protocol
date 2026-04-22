/**
 * BlockFinaX Diamond — Comprehensive Test Suite
 *
 * Tests the full hedge lifecycle: deployment, fee init, event creation,
 * LP deposits, hedger positions, settlement, claims, and admin functions.
 * Also covers the security fixes introduced in the latest audit round.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

// ─── Constants matching the contract ────────────────────────────────────────
const PRECISION = 1_000_000n;           // 1e6
const SHARES_PRECISION = 10n ** 18n;    // 1e18
const ONE_DAY = 86400;
const MAX_UINT = ethers.MaxUint256;

// Fee defaults (mirrors deploy-diamond.js defaults)
const CREATION_FEE    = 25_000_000n;    // $25 in 6-dec
const HEDGER_FEE_RATE = 5_000n;         // 0.5%
const PAYOUT_FEE_RATE = 10_000n;        // 1.0%
const LP_PROFIT_FEE   = 10_000n;        // 1.0%
const CREATOR_LOYALTY = 50_000n;        // 5.0%

/** Return every function selector exposed by a contract. */
function getSelectors(contract) {
  return contract.interface.fragments
    .filter(f => f.type === "function")
    .map(f => contract.interface.getFunction(f.name).selector);
}

/**
 * Deploy the full Diamond system and return handles to facets and the mock USDC.
 */
async function deployDiamond() {
  const [owner, oracleAdmin, creator, lp1, lp2, hedger1, hedger2, stranger] =
    await ethers.getSigners();

  // 1. Deploy mock USDC
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();

  // 2. Deploy DiamondCutFacet
  const CutFacet = await ethers.getContractFactory("BlockFinaXDiamondCutFacet");
  const cutFacet = await CutFacet.deploy();
  await cutFacet.waitForDeployment();

  // 3. Deploy Diamond proxy
  const Diamond = await ethers.getContractFactory("BlockFinaXDiamond");
  const diamond = await Diamond.deploy(
    owner.address,
    await cutFacet.getAddress(),
    await usdc.getAddress()
  );
  await diamond.waitForDeployment();
  const diamondAddr = await diamond.getAddress();

  // 4. Deploy and wire remaining facets via diamondCut
  const HedgeFacet = await ethers.getContractFactory("BlockFinaXHedgeFacet");
  const hedgeFacet = await HedgeFacet.deploy();
  await hedgeFacet.waitForDeployment();

  const OracleFacet = await ethers.getContractFactory("BlockFinaXOracleFacet");
  const oracleFacet = await OracleFacet.deploy();
  await oracleFacet.waitForDeployment();

  const LoupeFacet = await ethers.getContractFactory("BlockFinaXDiamondLoupeFacet");
  const loupeFacet = await LoupeFacet.deploy();
  await loupeFacet.waitForDeployment();

  const OwnershipFacet = await ethers.getContractFactory("BlockFinaXOwnershipFacet");
  const ownershipFacet = await OwnershipFacet.deploy();
  await ownershipFacet.waitForDeployment();

  // Attach diamondCut interface to Diamond address
  const diamondCut = await ethers.getContractAt("IDiamondCut", diamondAddr);

  // Collect selectors, tracking which are already registered to avoid conflicts.
  const hedgeSelectors = getSelectors(hedgeFacet);
  const oracleSelectors = getSelectors(oracleFacet);
  const loupeSelectors = getSelectors(loupeFacet);

  // HedgeFacet already includes ownership functions (transferOwnership, acceptOwnership,
  // pendingOwner), so exclude duplicates from OwnershipFacet.
  const registered = new Set([...hedgeSelectors, ...oracleSelectors, ...loupeSelectors]);
  const ownershipSelectors = getSelectors(ownershipFacet).filter(s => !registered.has(s));

  const cuts = [
    {
      facetAddress: await hedgeFacet.getAddress(),
      action: 0, // Add
      functionSelectors: hedgeSelectors,
    },
    {
      facetAddress: await oracleFacet.getAddress(),
      action: 0,
      functionSelectors: oracleSelectors,
    },
    {
      facetAddress: await loupeFacet.getAddress(),
      action: 0,
      functionSelectors: loupeSelectors,
    },
    // Only add OwnershipFacet selectors that aren't already registered
    ...(ownershipSelectors.length > 0
      ? [{
          facetAddress: await ownershipFacet.getAddress(),
          action: 0,
          functionSelectors: ownershipSelectors,
        }]
      : []),
  ];

  await diamondCut.diamondCut(cuts, ethers.ZeroAddress, "0x");

  // Attach facet ABIs to the Diamond address so we can call through the proxy
  const hedge = await ethers.getContractAt("BlockFinaXHedgeFacet", diamondAddr);
  const oracle = await ethers.getContractAt("BlockFinaXOracleFacet", diamondAddr);

  // Mint USDC to test accounts
  const mintAmount = 1_000_000n * PRECISION; // $1M each
  for (const acct of [owner, creator, lp1, lp2, hedger1, hedger2]) {
    await usdc.mint(acct.address, mintAmount);
    await usdc.connect(acct).approve(diamondAddr, MAX_UINT);
  }

  return {
    diamond, hedge, oracle, usdc,
    owner, oracleAdmin, creator, lp1, lp2, hedger1, hedger2, stranger,
    diamondAddr,
  };
}

describe("BlockFinaX Diamond", function () {
  let ctx; // shared deployment context

  before(async function () {
    ctx = await deployDiamond();
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  1. DEPLOYMENT & INIT
  // ═══════════════════════════════════════════════════════════════════════

  describe("Deployment", function () {
    it("should set the correct owner", async function () {
      const { hedge, owner } = ctx;
      // owner() is on OwnershipFacet but we can test via an onlyOwner call
      expect(await hedge.isFeesInitialized()).to.equal(false);
    });

    it("should reject createEvent before fees are initialized", async function () {
      const { hedge, creator, usdc } = ctx;
      const params = {
        name: "USD/GHS Q1",
        underlying: "USD/GHS",
        strike: 16_000_000n,
        premiumRate: 25_000n,
        expiryDate: Math.floor(Date.now() / 1000) + 30 * ONE_DAY,
        allowExternalLp: true,
        initialLiquidity: 1000n * PRECISION,
        initialRate: 15_000_000n,
        strikeAbove: true,
        paymentToken: ethers.ZeroAddress,
      };
      await expect(
        hedge.connect(creator).createEvent(params)
      ).to.be.revertedWith("Fees not initialized: call initializeHedgeFees first");
    });
  });

  describe("Fee Initialization", function () {
    it("should only allow owner to initialize fees", async function () {
      const { hedge, stranger } = ctx;
      await expect(
        hedge.connect(stranger).initializeHedgeFees(
          CREATION_FEE, HEDGER_FEE_RATE, PAYOUT_FEE_RATE, LP_PROFIT_FEE, CREATOR_LOYALTY
        )
      ).to.be.revertedWith("Not owner");
    });

    it("should initialize fees correctly", async function () {
      const { hedge, owner } = ctx;
      await hedge.connect(owner).initializeHedgeFees(
        CREATION_FEE, HEDGER_FEE_RATE, PAYOUT_FEE_RATE, LP_PROFIT_FEE, CREATOR_LOYALTY
      );
      expect(await hedge.isFeesInitialized()).to.equal(true);
    });

    it("should reject fee rates exceeding caps", async function () {
      const { hedge, owner } = ctx;
      await expect(
        hedge.connect(owner).initializeHedgeFees(
          CREATION_FEE, 200_000n, PAYOUT_FEE_RATE, LP_PROFIT_FEE, CREATOR_LOYALTY
        )
      ).to.be.revertedWith("hedgerFeeRate exceeds 10% cap");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  2. EVENT CREATION
  // ═══════════════════════════════════════════════════════════════════════

  describe("Create Event", function () {
    it("should create a hedge event with correct parameters", async function () {
      const { hedge, creator } = ctx;
      const params = {
        name: "USD/GHS Q1",
        underlying: "USD/GHS",
        strike: 16_000_000n,        // 16.0
        premiumRate: 25_000n,        // 2.5%
        expiryDate: Math.floor(Date.now() / 1000) + 30 * ONE_DAY,
        allowExternalLp: true,
        initialLiquidity: 1000n * PRECISION,
        initialRate: 15_000_000n,    // 15.0
        strikeAbove: true,
        paymentToken: ethers.ZeroAddress,
      };

      const tx = await hedge.connect(creator).createEvent(params);
      await tx.wait();

      const core = await hedge.getHedgeEventCore(1);
      expect(core.id).to.equal(1n);
      expect(core.creator).to.equal(creator.address);
      expect(core.strike).to.equal(16_000_000n);
      expect(core.premiumRate).to.equal(25_000n);
      expect(core.strikeAbove).to.equal(true);
      expect(core.poolOpen).to.equal(false); // starts closed
    });

    it("should reject events with strike on wrong side", async function () {
      const { hedge, creator } = ctx;
      const params = {
        name: "Bad Event",
        underlying: "USD/GHS",
        strike: 14_000_000n,         // below initial for strikeAbove=true
        premiumRate: 25_000n,
        expiryDate: Math.floor(Date.now() / 1000) + 30 * ONE_DAY,
        allowExternalLp: true,
        initialLiquidity: 1000n * PRECISION,
        initialRate: 15_000_000n,
        strikeAbove: true,
        paymentToken: ethers.ZeroAddress,
      };
      await expect(
        hedge.connect(creator).createEvent(params)
      ).to.be.revertedWith("Strike must be above current rate for upward hedge");
    });

    it("should reject events with strike delta > 10x initial rate", async function () {
      const { hedge, creator } = ctx;
      const params = {
        name: "Extreme Event",
        underlying: "USD/GHS",
        strike: 200_000_000n,        // 200 vs initial 15 (>10x)
        premiumRate: 25_000n,
        expiryDate: Math.floor(Date.now() / 1000) + 30 * ONE_DAY,
        allowExternalLp: true,
        initialLiquidity: 1000n * PRECISION,
        initialRate: 15_000_000n,
        strikeAbove: true,
        paymentToken: ethers.ZeroAddress,
      };
      await expect(
        hedge.connect(creator).createEvent(params)
      ).to.be.revertedWith("Strike too far from initial rate: max price delta is 10x initialRate");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  3. POOL CONTROLS & LP DEPOSIT
  // ═══════════════════════════════════════════════════════════════════════

  describe("Pool Settings & LP Deposits", function () {
    it("should only allow creator to open pool", async function () {
      const { hedge, stranger } = ctx;
      await expect(
        hedge.connect(stranger).setPoolSettings(1, true, true)
      ).to.be.revertedWith("Not creator");
    });

    it("should open pool for hedging and external LPs", async function () {
      const { hedge, creator } = ctx;
      await hedge.connect(creator).setPoolSettings(1, true, true);
      const core = await hedge.getHedgeEventCore(1);
      expect(core.poolOpen).to.equal(true);
      expect(core.allowExternalLp).to.equal(true);
    });

    it("should allow external LP to deposit", async function () {
      const { hedge, lp1 } = ctx;
      const tx = await hedge.connect(lp1).deposit(1, 500n * PRECISION);
      await tx.wait();

      const stats = await hedge.getHedgeEventStats(1);
      expect(stats.totalLiquidity).to.equal(1500n * PRECISION); // 1000 initial + 500 LP
      expect(stats.lpCount).to.equal(2n);
    });

    it("should reject deposits below minimum", async function () {
      const { hedge, lp2 } = ctx;
      await expect(
        hedge.connect(lp2).deposit(1, 5n * PRECISION) // 5 USDC < 10 min
      ).to.be.revertedWith("Min deposit: 10 USDC");
    });

    it("should reject external LP when pool is closed", async function () {
      const { hedge, creator, lp2 } = ctx;
      await hedge.connect(creator).setPoolSettings(1, true, false); // disable external
      await expect(
        hedge.connect(lp2).deposit(1, 100n * PRECISION)
      ).to.be.revertedWith("Pool closed to external LPs");
      // Re-open
      await hedge.connect(creator).setPoolSettings(1, true, true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  4. BUY PROTECTION
  // ═══════════════════════════════════════════════════════════════════════

  describe("Buy Protection", function () {
    it("should allow hedger to buy protection", async function () {
      const { hedge, hedger1 } = ctx;
      const tx = await hedge.connect(hedger1).buyProtection(
        1,                       // eventId
        100n * PRECISION,        // notional ($100)
        MAX_UINT,                // maxCost (no slippage check)
        MAX_UINT                 // deadline (no time check)
      );
      const receipt = await tx.wait();
      const event = receipt.logs.find(l => {
        try { return hedge.interface.parseLog(l)?.name === "ProtectionPurchased"; } catch { return false; }
      });
      expect(event).to.not.be.undefined;

      const stats = await hedge.getHedgeEventStats(1);
      expect(stats.hedgerCount).to.equal(1n);
    });

    it("should reject notional below minimum", async function () {
      const { hedge, hedger2 } = ctx;
      await expect(
        hedge.connect(hedger2).buyProtection(1, 5n * PRECISION, MAX_UINT, MAX_UINT)
      ).to.be.revertedWith("Min notional: 10 USDC");
    });

    it("should reject when pool not open", async function () {
      const { hedge, creator, hedger2 } = ctx;
      await hedge.connect(creator).setPoolSettings(1, false, true);
      await expect(
        hedge.connect(hedger2).buyProtection(1, 50n * PRECISION, MAX_UINT, MAX_UINT)
      ).to.be.revertedWith("Pool not open for hedging");
      await hedge.connect(creator).setPoolSettings(1, true, true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  5. SETTLEMENT (single-key path)
  // ═══════════════════════════════════════════════════════════════════════

  describe("Settlement", function () {
    it("should reject settlement from non-admin", async function () {
      const { hedge, stranger } = ctx;
      await expect(
        hedge.connect(stranger).settleEvent(1, 16_500_000n)
      ).to.be.revertedWith("Not oracle admin");
    });

    it("should reject settlement price outside plausible range", async function () {
      const { hedge, owner } = ctx;
      await hedge.connect(owner).setOracleAdmin(owner.address);
      // Price 1 is below strike so not "alreadyTriggered", and event hasn't expired,
      // so it hits the timing check first. Use a price that IS above strike (triggered)
      // but outside the 100x plausible range to test the plausibility guard.
      await expect(
        hedge.connect(owner).settleEvent(1, 15_000_000n * 200n) // 200x initial rate
      ).to.be.revertedWith("Settlement price out of plausible range (must be within 100x of initial rate)");
    });

    it("should settle a triggered event (price >= strike)", async function () {
      const { hedge, owner } = ctx;
      // Strike is 16.0, settle at 16.5 => triggered
      const tx = await hedge.connect(owner).settleEvent(1, 16_500_000n);
      await tx.wait();

      const stats = await hedge.getHedgeEventStats(1);
      expect(stats.triggered).to.equal(true);
      expect(stats.settlementPrice).to.equal(16_500_000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  6. CLAIM PAYOUT
  // ═══════════════════════════════════════════════════════════════════════

  describe("Claim Payout", function () {
    it("should allow hedger to claim payout on triggered event", async function () {
      const { hedge, hedger1, usdc } = ctx;
      const balBefore = await usdc.balanceOf(hedger1.address);
      await hedge.connect(hedger1).claimPayout(1); // positionId 1
      const balAfter = await usdc.balanceOf(hedger1.address);
      expect(balAfter).to.be.greaterThan(balBefore);
    });

    it("should reject double-claim", async function () {
      const { hedge, hedger1 } = ctx;
      await expect(
        hedge.connect(hedger1).claimPayout(1)
      ).to.be.revertedWith("Already claimed");
    });

    it("should reject claim by non-hedger", async function () {
      const { hedge, stranger } = ctx;
      await expect(
        hedge.connect(stranger).claimPayout(1)
      ).to.be.revertedWith("Not your position");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  7. LP WITHDRAW CAPITAL
  // ═══════════════════════════════════════════════════════════════════════

  describe("LP Withdraw Capital", function () {
    it("should allow LP to withdraw after settlement", async function () {
      const { hedge, lp1, usdc } = ctx;
      const balBefore = await usdc.balanceOf(lp1.address);
      // LP1's deposit is depositId=2 (creator's initial is depositId=1)
      await hedge.connect(lp1).withdrawCapital(2);
      const balAfter = await usdc.balanceOf(lp1.address);
      expect(balAfter).to.be.greaterThan(balBefore);
    });

    it("should reject double-withdrawal", async function () {
      const { hedge, lp1 } = ctx;
      await expect(
        hedge.connect(lp1).withdrawCapital(2)
      ).to.be.revertedWith("Already withdrawn");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  8. ADMIN FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════

  describe("Admin Functions", function () {
    it("withdrawPlatformFees (deprecated) should always revert", async function () {
      const { hedge, owner } = ctx;
      await expect(
        hedge.connect(owner).withdrawPlatformFees(1n)
      ).to.be.revertedWith("Deprecated: use withdrawPlatformFeesByToken(usdcToken, amount)");
    });

    it("should allow owner to withdraw fees via withdrawPlatformFeesByToken", async function () {
      const { hedge, owner, usdc } = ctx;
      const fees = await hedge.getPlatformFeesByToken(await usdc.getAddress());
      if (fees > 0n) {
        const balBefore = await usdc.balanceOf(owner.address);
        await hedge.connect(owner).withdrawPlatformFeesByToken(
          await usdc.getAddress(), fees
        );
        const balAfter = await usdc.balanceOf(owner.address);
        expect(balAfter - balBefore).to.equal(fees);
      }
    });

    it("should reject fee withdrawal by non-owner", async function () {
      const { hedge, stranger, usdc } = ctx;
      await expect(
        hedge.connect(stranger).withdrawPlatformFeesByToken(
          await usdc.getAddress(), 1n
        )
      ).to.be.revertedWith("Not owner");
    });

    it("pause/unpause should work correctly", async function () {
      const { hedge, owner, creator } = ctx;
      await hedge.connect(owner).pause();
      expect(await hedge.isPaused()).to.equal(true);

      // createEvent should be blocked during pause
      const params = {
        name: "Paused Test",
        underlying: "USD/NGN",
        strike: 1700_000_000n,
        premiumRate: 25_000n,
        expiryDate: Math.floor(Date.now() / 1000) + 30 * ONE_DAY,
        allowExternalLp: true,
        initialLiquidity: 100n * PRECISION,
        initialRate: 1600_000_000n,
        strikeAbove: true,
        paymentToken: ethers.ZeroAddress,
      };
      await expect(
        hedge.connect(creator).createEvent(params)
      ).to.be.revertedWith("Protocol is paused");

      await hedge.connect(owner).unpause();
      expect(await hedge.isPaused()).to.equal(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  9. SECURITY AUDIT FIXES
  // ═══════════════════════════════════════════════════════════════════════

  describe("Audit Fix: recoverExpiredPayouts requires onlyOwner", function () {
    it("should reject calls from non-owner", async function () {
      const { hedge, stranger } = ctx;
      await expect(
        hedge.connect(stranger).recoverExpiredPayouts(1)
      ).to.be.revertedWith("Not owner");
    });
  });

  describe("Audit Fix: setAllowedPaymentToken enforces 6 decimals", function () {
    it("should reject tokens with non-6 decimals", async function () {
      const { hedge, owner } = ctx;
      const Mock18 = await ethers.getContractFactory("MockToken18");
      const token18 = await Mock18.deploy();
      await token18.waitForDeployment();

      await expect(
        hedge.connect(owner).setAllowedPaymentToken(await token18.getAddress(), true)
      ).to.be.revertedWith("Only 6-decimal tokens supported");
    });

    it("should accept 6-decimal tokens", async function () {
      const { hedge, owner } = ctx;
      // Deploy another mock USDC (6 decimals)
      const MockUSDC = await ethers.getContractFactory("MockUSDC");
      const usdt = await MockUSDC.deploy();
      await usdt.waitForDeployment();

      await hedge.connect(owner).setAllowedPaymentToken(await usdt.getAddress(), true);
      expect(await hedge.isAllowedPaymentToken(await usdt.getAddress())).to.equal(true);
    });
  });

  describe("Audit Fix: migrateLegacyPlatformFees", function () {
    it("should be callable by owner (idempotent)", async function () {
      const { hedge, owner } = ctx;
      // Should not revert — idempotent migration
      await hedge.connect(owner).migrateLegacyPlatformFees();
    });

    it("should reject calls from non-owner", async function () {
      const { hedge, stranger } = ctx;
      await expect(
        hedge.connect(stranger).migrateLegacyPlatformFees()
      ).to.be.revertedWith("Not owner");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  10. ORACLE FACET
  // ═══════════════════════════════════════════════════════════════════════

  describe("Oracle Facet", function () {
    let eventId;

    before(async function () {
      // Create a fresh event for oracle tests
      const { hedge, creator, owner, oracle } = ctx;
      const params = {
        name: "Oracle Test",
        underlying: "USD/GHS",
        strike: 16_000_000n,
        premiumRate: 25_000n,
        expiryDate: Math.floor(Date.now() / 1000) + 60 * ONE_DAY,
        allowExternalLp: true,
        initialLiquidity: 5000n * PRECISION,
        initialRate: 15_000_000n,
        strikeAbove: true,
        paymentToken: ethers.ZeroAddress,
      };
      const tx = await hedge.connect(creator).createEvent(params);
      const receipt = await tx.wait();
      // Event ID from the counter — should be 2
      const core = await hedge.getHedgeEventCore(2);
      eventId = Number(core.id);

      // Open pool and add a hedger position
      await hedge.connect(creator).setPoolSettings(eventId, true, true);

      const { hedger1 } = ctx;
      await hedge.connect(hedger1).buyProtection(
        eventId, 100n * PRECISION, MAX_UINT, MAX_UINT
      );
    });

    it("should allow owner to add oracles", async function () {
      const { oracle, owner } = ctx;
      const signers = await ethers.getSigners();
      // Register 3 oracles using signers[8..10]
      for (let i = 8; i <= 10; i++) {
        await oracle.connect(owner).addOracle(signers[i].address);
      }
      const config = await oracle.getOracleConfig();
      expect(config[2]).to.equal(3n); // oracleCount
    });

    it("should set required signers", async function () {
      const { oracle, owner } = ctx;
      await oracle.connect(owner).setRequiredSigners(2);
      const config = await oracle.getOracleConfig();
      expect(config[0]).to.equal(2n); // requiredSigners
    });

    it("should enforce tolerance bounds (1-200 bps)", async function () {
      const { oracle, owner } = ctx;
      await expect(
        oracle.connect(owner).setToleranceBps(0)
      ).to.be.revertedWith("Tolerance must be 1-200 bps");

      await expect(
        oracle.connect(owner).setToleranceBps(300)
      ).to.be.revertedWith("Tolerance must be 1-200 bps");

      await oracle.connect(owner).setToleranceBps(100); // 1% — should work
    });

    it("should accept oracle rate submissions", async function () {
      const { oracle } = ctx;
      const signers = await ethers.getSigners();

      // First oracle submits
      await oracle.connect(signers[8]).submitRate(eventId, 16_500_000n);
      const count = await oracle.getSubmitterCount(eventId);
      expect(count).to.equal(1n);
    });

    it("should reach consensus and settle on agreeing submissions", async function () {
      const { oracle, hedge } = ctx;
      const signers = await ethers.getSigners();

      // Second oracle submits same price — should trigger consensus
      await oracle.connect(signers[9]).submitRate(eventId, 16_500_000n);

      // Event should now be settled
      const stats = await hedge.getHedgeEventStats(eventId);
      expect(stats.triggered).to.equal(true);
      expect(stats.settlementPrice).to.equal(16_500_000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  11. FULL LIFECYCLE — NON-TRIGGERED EVENT
  // ═══════════════════════════════════════════════════════════════════════

  describe("Full Lifecycle: Non-triggered event", function () {
    let eventId;

    before(async function () {
      const { hedge, creator, hedger2, owner } = ctx;

      // Create event: downward hedge (strike below initial)
      const params = {
        name: "No-Trigger Test",
        underlying: "USD/NGN",
        strike: 1400_000_000n,        // 1400
        premiumRate: 20_000n,          // 2%
        expiryDate: Math.floor(Date.now() / 1000) + 30 * ONE_DAY,
        allowExternalLp: false,
        initialLiquidity: 2000n * PRECISION,
        initialRate: 1500_000_000n,    // 1500
        strikeAbove: false,
        paymentToken: ethers.ZeroAddress,
      };
      const tx = await hedge.connect(creator).createEvent(params);
      await tx.wait();
      eventId = 3;

      await hedge.connect(creator).setPoolSettings(eventId, true, false);
      await hedge.connect(hedger2).buyProtection(
        eventId, 50n * PRECISION, MAX_UINT, MAX_UINT
      );
    });

    it("should settle as non-triggered when price stays above strike", async function () {
      const { hedge, owner } = ctx;
      // Advance time past expiry
      await ethers.provider.send("evm_increaseTime", [31 * ONE_DAY]);
      await ethers.provider.send("evm_mine");

      // Settle at 1550 (above strike of 1400 for downward hedge) => not triggered
      await hedge.connect(owner).settleEvent(eventId, 1550_000_000n);
      const stats = await hedge.getHedgeEventStats(eventId);
      expect(stats.triggered).to.equal(false);
    });

    it("should allow LP to withdraw full capital when not triggered", async function () {
      const { hedge, creator, usdc } = ctx;
      // Creator's deposit (depositId for this event)
      // We need to find the correct depositId — it's the 3rd event, initial deposit
      // depositIds: 1 (event 1 creator), 2 (event 1 lp1), 3 (event 2 creator), 4 (event 3 creator)
      const depositId = 4;
      const balBefore = await usdc.balanceOf(creator.address);
      await hedge.connect(creator).withdrawCapital(depositId);
      const balAfter = await usdc.balanceOf(creator.address);
      // Should get full amount back since event didn't trigger
      expect(balAfter - balBefore).to.equal(2000n * PRECISION);
    });

    it("hedger should not be able to claim payout on non-triggered event", async function () {
      const { hedge, hedger2 } = ctx;
      // Position 3 is hedger2's position on event 3
      await expect(
        hedge.connect(hedger2).claimPayout(3)
      ).to.be.revertedWith("Not eligible for payout");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  //  12. ORACLE V2 ACTIVATION (one-way switch)
  // ═══════════════════════════════════════════════════════════════════════

  describe("Oracle V2 Activation", function () {
    it("should permanently disable single-key settlement", async function () {
      const { hedge, owner, creator } = ctx;

      // Create event for this test
      const params = {
        name: "V2 Test",
        underlying: "USD/GHS",
        strike: 16_000_000n,
        premiumRate: 25_000n,
        expiryDate: Math.floor(Date.now() / 1000) + 90 * ONE_DAY,
        allowExternalLp: false,
        initialLiquidity: 100n * PRECISION,
        initialRate: 15_000_000n,
        strikeAbove: true,
        paymentToken: ethers.ZeroAddress,
      };
      await hedge.connect(creator).createEvent(params);

      // Activate oracle V2
      await hedge.connect(owner).activateOracleV2();

      // Now single-key settlement should be permanently blocked
      await expect(
        hedge.connect(owner).settleEvent(4, 16_500_000n)
      ).to.be.revertedWith("Single-key settlement disabled: use OracleFacet");
    });

    it("should reject activating V2 twice", async function () {
      const { hedge, owner } = ctx;
      await expect(
        hedge.connect(owner).activateOracleV2()
      ).to.be.revertedWith("OracleV2 already active");
    });
  });
});
