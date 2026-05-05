// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/**
 * @title LibAppStorage
 * @author BlockFinaX Protocol
 * @notice Diamond-pattern shared storage library for the BlockFinaX protocol.
 *
 * @dev All protocol state lives in a single `AppStorage` struct stored at a
 *      deterministic keccak256 slot (APP_STORAGE_POSITION). This follows the
 *      Diamond Storage pattern described in EIP-2535, ensuring that all facets
 *      delegatecalled by the Diamond proxy read and write from the same storage
 *      location without slot collision.
 *
 *      Facets access storage exclusively via `LibAppStorage.appStorage()`.
 *      No facet may declare contract-level state variables.
 *
 *      Monetary values: all USDC amounts use 6 decimals (USDC standard).
 *      Rate/percentage values: use PRECISION = 1e6 as denominator (100% = 1e6).
 */
library LibAppStorage {
    /// @dev Unique storage slot for AppStorage. Chosen to avoid collision with
    ///      LibDiamond (diamond.standard.diamond.storage) and LibOracleStorage.
    bytes32 constant APP_STORAGE_POSITION = keccak256("blockfinax.app.storage");

    // ============================================================
    //                    ENUMS
    // ============================================================

    /**
     * @notice Lifecycle status of a hedge event.
     * @param Open     Event is active: deposits, purchases, and settlement are possible.
     * @param Settled  Oracle has posted the final rate; positions are resolved.
     * @param Expired  Reserved for future use; events currently transition Open → Settled only.
     *                 Never assigned by current code. withdrawCapital() permits this status
     *                 to remain forward-compatible should expiry-without-settlement be added.
     */
    enum HedgeEventStatus { Open, Settled, Expired }

    /**
     * @notice Lifecycle status of a hedger position.
     * @param Active      Purchased and awaiting settlement.
     * @param SettledWin  Legacy status — never written by current code. Retained in the enum
     *                    to preserve on-chain ABI compatibility; settleEvent() sets Claimable
     *                    instead. claimPayout() still accepts this value for backward compat.
     * @param SettledLoss Legacy status — never written by current code. Retained in the enum
     *                    to preserve on-chain ABI compatibility; settleEvent() sets Expired
     *                    instead.
     * @param Claimed     Payout has been successfully claimed by the hedger.
     * @param Claimable   Strike was touched; hedger may call claimPayout().
     * @param Expired     Strike was not touched; payoutAmount = 0, position is closed.
     */
    enum HedgePositionStatus { Active, SettledWin, SettledLoss, Claimed, Claimable, Expired }

    // ============================================================
    //                    STRUCTS
    // ============================================================

    /**
     * @notice Represents a single hedge event (FX protection pool).
     *
     * @param id              Unique event identifier (auto-incremented from hedgeEventCounter).
     * @param creator         Address that created the event and made the initial deposit.
     * @param name            Human-readable label for the event.
     * @param underlying      Currency pair identifier, e.g. "USD/GHS".
     * @param strike          Trigger price in 6-decimal units. Hedge pays out if price touches this.
     * @param premiumRate     Premium charged to hedgers as a fraction of notional (PRECISION denominator).
     * @param expiryDate      Unix timestamp after which no new positions can be opened.
     * @param status          Current lifecycle stage of the event.
     * @param settlementPrice Final FX rate posted by the oracle at settlement (6 decimals). 0 before settlement.
     * @param triggered       True if settlementPrice touched the strike, meaning hedgers win.
     * @param settledAt       Unix timestamp of settlement. 0 before settlement.
     * @param poolOpen        Whether new hedger positions are currently accepted.
     * @param allowExternalLp Whether LP wallets other than the creator can deposit.
     * @param creatorEarnings Accumulated creator loyalty earnings not yet withdrawn (USDC, 6 decimals).
     * @param totalLiquidity  Total USDC deposited by all LPs (6 decimals).
     * @param totalExposure   Sum of all hedger notionals (6 decimals). Informational only.
     * @param totalPremiums   Sum of all premiums collected from hedgers (6 decimals). Informational only.
     * @param lpCount         Historical count of LP deposit calls (not unique LP addresses).
     * @param hedgerCount     Total number of hedger positions created on this event.
     * @param createdAt       Unix timestamp of event creation.
     * @param initialRate     Market rate at creation time (6 decimals). Used to compute predetermined payouts.
     * @param totalMaxPayout  Sum of all predetermined payouts reserved from pool liquidity (6 decimals).
     * @param strikeAbove     true = upward hedge (pays out if price >= strike); false = downward hedge.
     */
    struct HedgeEvent {
        uint256 id;
        address creator;
        string name;
        string underlying;
        uint256 strike;
        uint256 premiumRate;
        uint256 expiryDate;
        HedgeEventStatus status;
        uint256 settlementPrice;
        bool triggered;
        uint256 settledAt;
        bool poolOpen;
        bool allowExternalLp;
        uint256 creatorEarnings;
        uint256 totalLiquidity;
        uint256 totalExposure;
        uint256 totalPremiums;
        uint256 lpCount;
        uint256 hedgerCount;
        uint256 createdAt;
        uint256 initialRate;
        uint256 totalMaxPayout;
        bool strikeAbove;
        /// @dev Running total of USDC actually paid out via claimPayout(). Added in v2.
        ///      Appended at end of struct to preserve storage layout for existing deployments.
        uint256 totalPayoutClaimed;

        /// @dev Stablecoin used for all payments in this event (USDC, USDT, etc.). Added in v3.
        ///      Zero address falls back to s.usdcToken so pre-v3 events continue working unchanged.
        address paymentToken;

        // ── v5 additions (always append at end to preserve Diamond storage layout) ──────────

        /// @dev Fee rates snapshotted from the global HedgeFeeConfig at createEvent() time.
        ///      Guarantees that hedgers, LPs and the creator all operate under the fee schedule
        ///      that was in effect when they committed capital — changes to the global config
        ///      cannot retroactively alter active events. feeSnapshotSet is false on pre-v5
        ///      events; callers fall back to the global config in that case.
        uint256 snapshotHedgerFeeRate;
        uint256 snapshotPayoutFeeRate;
        uint256 snapshotLpProfitFeeRate;
        uint256 snapshotCreatorLoyaltyRate;
        bool feeSnapshotSet;

        /// @dev MasterChef-style premium accumulator. Scaled by ACC_PREMIUM_MULTIPLIER (1e18).
        ///      Incremented in O(1) on every buyProtection() call instead of iterating all LP
        ///      deposits. LPs compute their pending share lazily at claimPremiums() time.
        uint256 accPremiumPerShare;

        /// @dev Running sum of shares held by non-withdrawn LP deposits.
        ///      Maintained in deposit() and withdrawCapital(); eliminates the O(n)
        ///      _getTotalShares() loop that previously ran inside deposit().
        uint256 totalActiveShares;

        // ── v6 additions: always append at end to preserve Diamond storage layout ──────────

        /// @dev C-1 fix: snapshot of totalLiquidity taken at settlement time.
        ///      withdrawCapital() uses this value instead of the live totalLiquidity to compute
        ///      each LP's proportional payout share. Without the snapshot, LPs who withdraw
        ///      later (after other LPs have already withdrawn) see a shrinking denominator and
        ///      are charged a disproportionately large payout share.
        uint256 liquidityAtSettlement;

        /// @dev H-2 fix: accumulated integer remainder from the per-share premium accumulator.
        ///      Each buyProtection() call increments accPremiumPerShare by
        ///      (premium * ACC_PREMIUM_MULTIPLIER) / totalActiveShares; any remainder is dust.
        ///      Dust is accumulated here and distributed when it exceeds totalActiveShares,
        ///      ensuring no premium is silently lost to integer truncation.
        uint256 premiumDust;

        // ── v7 additions: range-based payout product (call/put spread) ─────────────────────
        // Always append at end to preserve Diamond storage layout for existing deployments.

        /// @dev Far end of the payout range. Together with `strike`, defines a continuous
        ///      payout zone instead of a single trigger point.
        ///
        ///      Geometry by direction:
        ///        strikeAbove = true  (upward hedge):
        ///            initialRate < strike < payoutCap
        ///            Payout begins above `strike`, scales linearly with the move,
        ///            and is capped when settlement reaches `payoutCap`.
        ///        strikeAbove = false (downward hedge):
        ///            payoutCap < strike < initialRate
        ///            Payout begins below `strike`, scales linearly with the move,
        ///            and is capped when settlement reaches `payoutCap`.
        ///
        ///      Per-notional max payout = |payoutCap - strike| / initialRate.
        ///      Capped at 10x via createEvent() validation, same spirit as the
        ///      pre-v7 priceDelta cap.
        ///
        ///      A value of 0 means "single-strike legacy event" (pre-v7); the settlement
        ///      and buy paths fall back to the original digital-option formula in that case.
        ///      No live events exist at v7 cut time, so the legacy branch is essentially
        ///      dead code retained only for forward-compatibility safety.
        uint256 payoutCap;

        // ── v8 additions: pricing-engine attestation ───────────────────────────────────────
        // Always append at end to preserve Diamond storage layout.

        /// @dev Recovered ECDSA signer of the pricing-engine quote that authorised this event.
        ///      address(0) means the event was created without a quote attestation (allowed
        ///      only when the global pricingEngineSigner is unset; once set, every new event
        ///      MUST carry a valid signature and this field will equal pricingEngineSigner).
        ///
        ///      Anyone reading the event can independently verify "this premium was blessed
        ///      by the pricing engine" by checking quoteSigner != 0.
        address quoteSigner;
    }

    /**
     * @notice Represents a single hedger position on a hedge event.
     *
     * @param id              Unique position identifier (auto-incremented from hedgePositionCounter).
     * @param eventId         The hedge event this position belongs to.
     * @param hedger          Wallet address that purchased this position.
     * @param notional        Coverage amount in USDC (6 decimals).
     * @param premiumPaid     Premium paid by the hedger at buyProtection() (USDC, 6 decimals).
     * @param platformFeePaid Platform fee paid by the hedger at buyProtection() (USDC, 6 decimals).
     * @param payoutAmount    Reserved/actual payout in payment-token units (6 decimals).
     *                        At buyProtection() this is set to the WORST-CASE payout (settlement
     *                        reaching the cap end of the range) so the pool can reserve enough
     *                        liquidity for the position.
     *                        At settlement settleEvent() overwrites this with the ACTUAL payout
     *                        based on where the settlement price lands within the range. Set to
     *                        0 if the event did not trigger.
     *                        For pre-v7 single-strike events (event.payoutCap == 0) the buy-time
     *                        and settlement-time values coincide.
     * @param status          Current lifecycle status of this position.
     * @param claimed         Whether claimPayout() has been successfully called.
     * @param createdAt       Unix timestamp of position creation.
     */
    struct HedgePosition {
        uint256 id;
        uint256 eventId;
        address hedger;
        uint256 notional;
        uint256 premiumPaid;
        uint256 platformFeePaid;
        uint256 payoutAmount;
        HedgePositionStatus status;
        bool claimed;
        uint256 createdAt;
    }

    /**
     * @notice Represents a single LP deposit into a hedge event pool.
     *
     * @param id              Unique deposit identifier (auto-incremented from hedgeLpDepositCounter).
     * @param eventId         The hedge event this deposit belongs to.
     * @param lp              Wallet address that made this deposit.
     * @param amount          USDC deposited (6 decimals).
     * @param shares          Share tokens received, representing proportional pool ownership.
     *                        Used to calculate the LP's fraction of premium distributions.
     * @param premiumsEarned  Cumulative premiums allocated to this deposit across all buyProtection() calls (USDC, 6 decimals).
     * @param premiumsClaimed Cumulative premiums already withdrawn via claimPremiums() (USDC, 6 decimals).
     * @param withdrawn       Whether withdrawCapital() has been successfully called.
     * @param withdrawnAt     Unix timestamp of capital withdrawal. 0 before withdrawal.
     * @param createdAt       Unix timestamp of deposit creation.
     * @param rewardDebt      MasterChef reward debt (v5). Scaled by ACC_PREMIUM_MULTIPLIER (1e18).
     *                        Set at deposit time to prevent the LP from claiming premiums that
     *                        were distributed before they joined. Updated after each claim.
     */
    struct HedgeLpDeposit {
        uint256 id;
        uint256 eventId;
        address lp;
        uint256 amount;
        uint256 shares;
        uint256 premiumsEarned;
        uint256 premiumsClaimed;
        bool withdrawn;
        uint256 withdrawnAt;
        uint256 createdAt;
        /// @dev Appended at end to preserve Diamond storage layout for existing deployments.
        uint256 rewardDebt;
    }

    /**
     * @notice Protocol fee configuration. All rates use PRECISION = 1e6 as denominator.
     *
     * @param eventCreationFee   Flat USDC amount charged to the creator at createEvent() (6 decimals).
     * @param hedgerFeeRate      Platform fee on notional charged to hedger at buyProtection().
     *                           E.g. 5000 = 0.5% (5000 / 1e6).
     * @param hedgerPayoutFeeRate Platform fee deducted from gross payout at claimPayout().
     *                           E.g. 10000 = 1%.
     * @param lpProfitFeeRate    Platform fee deducted from premium claim at claimPremiums().
     *                           E.g. 10000 = 1%.
     * @param creatorLoyaltyRate Share of every platform fee credited to the event creator.
     *                           E.g. 50000 = 5%.
     */
    struct HedgeFeeConfig {
        uint256 eventCreationFee;
        uint256 hedgerFeeRate;
        uint256 hedgerPayoutFeeRate;
        uint256 lpProfitFeeRate;
        uint256 creatorLoyaltyRate;
    }

    /**
     * @notice Root storage struct for the BlockFinaX protocol.
     * @dev Accessed via appStorage(). All fields are zero-initialised at deployment.
     *      New fields should always be appended at the end to preserve storage layout
     *      compatibility with existing deployed Diamond facets.
     */
    struct AppStorage {
        /// @dev Address of the USDC ERC-20 token contract used for all payments.
        address usdcToken;

        // ============================================================
        //                    HEDGE STORAGE
        // ============================================================

        /// @dev All hedge events, keyed by event ID.
        mapping(uint256 => HedgeEvent) hedgeEvents;

        /// @dev Auto-incrementing counter used to assign event IDs. Current value = last assigned ID.
        uint256 hedgeEventCounter;

        /// @dev Total number of hedge events ever created (same as hedgeEventCounter).
        /// @dev L-1: This field is a legacy duplicate of hedgeEventCounter and was never
        ///      independently maintained. It cannot be removed without breaking the Diamond
        ///      storage layout of deployed contracts. getTotalHedgeEvents() reads
        ///      hedgeEventCounter directly. New code must not write to this field.
        uint256 totalHedgeEvents;

        /// @dev All hedger positions, keyed by position ID.
        mapping(uint256 => HedgePosition) hedgePositions;

        /// @dev Auto-incrementing counter used to assign position IDs.
        uint256 hedgePositionCounter;

        /// @dev All LP deposits, keyed by deposit ID.
        mapping(uint256 => HedgeLpDeposit) hedgeLpDeposits;

        /// @dev Auto-incrementing counter used to assign deposit IDs.
        uint256 hedgeLpDepositCounter;

        /// @dev Ordered list of position IDs for each event. Bounded by MAX_POSITIONS_PER_EVENT.
        mapping(uint256 => uint256[]) hedgeEventPositionIds;

        /// @dev Ordered list of deposit IDs for each event. Bounded by MAX_DEPOSITS_PER_EVENT.
        mapping(uint256 => uint256[]) hedgeEventDepositIds;

        /// @dev Event IDs created by each creator address.
        mapping(address => uint256[]) hedgeCreatorEventIds;

        /// @dev Position IDs owned by each hedger address (across all events).
        mapping(address => uint256[]) hedgerPositionIds;

        /// @dev Deposit IDs owned by each LP address (across all events).
        mapping(address => uint256[]) lpDepositIds;

        /// @dev Protocol fee parameters. Must be initialised via initializeHedgeFees() before use.
        HedgeFeeConfig hedgeFeeConfig;

        /// @dev Cumulative platform fees collected and not yet withdrawn by the owner (USDC, 6 decimals).
        uint256 hedgePlatformFeesCollected;

        /// @dev Single-key oracle admin address authorised to call settleEvent() directly.
        ///      The Diamond owner always retains settlement rights regardless of this setting.
        address hedgeOracleAdmin;

        // ============================================================
        //                    SECURITY FLAGS
        // ============================================================

        /// @dev Reentrancy mutex. True while a nonReentrant function is executing.
        ///      Stored in AppStorage (not contract state) because facets are delegatecalled.
        bool hedgeReentrancyLock;

        /// @dev Emergency pause flag. True blocks all user-facing state-changing functions.
        ///      Settlement via settleEvent() remains available while paused.
        bool paused;

        /// @dev One-way flag: once set true by activateOracleV2(), the single-key settleEvent()
        ///      path in HedgeFacet is permanently disabled and all settlement must go through
        ///      the multi-oracle consensus path in OracleFacet. Cannot be unset.
        bool oracleV2Active;

        /// @dev Confirms that initializeHedgeFees() has been called at least once.
        ///      createEvent() reverts until this is true.
        bool feesInitialized;

        // ============================================================
        //                    MULTI-TOKEN SUPPORT (v3)
        // ============================================================

        /// @dev Whitelist of stablecoin tokens that creators can choose as the payment currency
        ///      when creating a new hedge event. The default (usdcToken) is always implicitly allowed.
        mapping(address => bool) allowedPaymentTokens;

        /// @dev Platform fees accumulated per payment token. Replaces the single
        ///      hedgePlatformFeesCollected counter for multi-token accounting.
        ///      hedgePlatformFeesCollected is kept for backward compatibility with existing reads.
        mapping(address => uint256) platformFeesByToken;

        /// @dev C-2 fix: tracks net tokens held by the Diamond for each payment token.
        ///      Incremented by every safeTransferFrom (tokens flowing in) and decremented by
        ///      every safeTransfer (tokens flowing out). Used in place of
        ///      IERC20.balanceOf(address(this)) to prevent donation / re-entrancy attacks
        ///      where an attacker inflates the on-chain balance to manipulate fee recovery.
        mapping(address => uint256) tokenReserves;

        // ============================================================
        //                    v8: PRICING-ENGINE ATTESTATION
        // ============================================================

        /// @dev ECDSA public key of the off-chain pricing engine. Set via
        ///      setPricingEngineSigner() (owner-only). When zero, signature verification
        ///      is disabled and createEvent() accepts events without quote attestation
        ///      (legacy / migration mode). When non-zero, every createEvent() MUST carry
        ///      a valid signature from this signer.
        ///
        ///      Rotate by calling setPricingEngineSigner() with a new address. Previously
        ///      issued quotes with the old signer become invalid immediately on rotation.
        address pricingEngineSigner;

        /// @dev Replay-protection set: every quote nonce that has been consumed by
        ///      createEvent(). The pricing engine generates fresh 32-byte nonces per
        ///      quote; the contract marks each one used the first time it's submitted.
        mapping(bytes32 => bool) usedQuoteNonces;
    }

    /**
     * @notice Returns a storage pointer to the protocol's AppStorage struct.
     * @dev Uses inline assembly to point to the deterministic APP_STORAGE_POSITION slot.
     *      This is the standard Diamond Storage access pattern from EIP-2535.
     * @return s Storage pointer to AppStorage.
     */
    function appStorage() internal pure returns (AppStorage storage s) {
        bytes32 position = APP_STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
