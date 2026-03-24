// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibAppStorage} from "../libraries/LibAppStorage.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

/**
 * @title BlockFinaXHedgeFacet
 * @author BlockFinaX Protocol
 * @notice On-chain P2P parametric FX protection marketplace built on the EIP-2535 Diamond Standard.
 *
 * @dev This facet implements the full hedge lifecycle:
 *
 *   Lifecycle:
 *     1. Owner calls initializeHedgeFees() once after deployment.
 *     2. Creator calls createEvent() — pays creation fee, deposits initial liquidity.
 *     3. Creator calls setPoolSettings(true) — opens pool for hedgers and/or external LPs.
 *     4. External LPs call deposit() — add USDC, receive proportional shares.
 *     5. Hedgers call buyProtection() — pay premium (distributed to LPs) + platform fee.
 *     6. Oracle admin calls settleEvent() — posts FX rate, resolves all positions.
 *     7. Winning hedgers call claimPayout() — collect payout (minus hedger payout fee).
 *     8. LPs call claimPremiums() — collect earned premiums (minus LP profit fee).
 *     9. LPs call withdrawCapital() — retrieve deposited USDC after settlement.
 *
 *   Fee structure (all configurable via initializeHedgeFees):
 *     - Event creation : flat USDC fee → platform
 *     - Hedger fee     : % of notional → platform (on top of premium)
 *     - Hedger payout  : % of gross payout → platform (deducted at claim)
 *     - LP profit fee  : % of premium claim → platform (deducted at claim)
 *     - Creator loyalty: % of every platform fee → event creator
 *
 *   Security model:
 *     - nonReentrant on all state-changing user functions (Diamond-compatible mutex).
 *     - CEI (Check-Effects-Interactions) ordering — external calls always last.
 *     - Emergency pause via pause()/unpause() — stops user functions, not settlement.
 *     - Two-step ownership transfer to prevent accidental lockout.
 *     - Loop bounds: MAX_POSITIONS_PER_EVENT = 500, MAX_DEPOSITS_PER_EVENT = 200.
 *     - createEvent() blocked until initializeHedgeFees() has been called.
 *     - premiumRate capped at 100% (PRECISION); expiryDate capped at 365 days.
 *
 *   Storage:
 *     All state lives in LibAppStorage.AppStorage at a deterministic Diamond storage slot.
 *     No contract-level state variables are used (required for Diamond delegatecall).
 *
 *   USDC denomination:
 *     All monetary values use 6 decimals (USDC standard).
 *     Rates and percentages use PRECISION = 1e6 as the denominator (e.g. 25000 = 2.5%).
 */
contract BlockFinaXHedgeFacet {
    using SafeERC20 for IERC20;

    /// @dev Denominator for all rate/percentage calculations (1e6 = 100%).
    uint256 constant PRECISION = 1e6;

    /// @dev Initial share-to-USDC multiplier for the first deposit in a pool.
    uint256 constant SHARES_PRECISION = 1e18;

    /// @dev Hard cap on hedger positions per event. Bounds the gas cost of settleEvent().
    uint256 constant MAX_POSITIONS_PER_EVENT = 500;

    /// @dev Hard cap on LP deposits per event. Bounds the gas cost of _distributePremiumToLps().
    uint256 constant MAX_DEPOSITS_PER_EVENT = 200;

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when a new hedge event is created.
    event HedgeEventCreated(
        uint256 indexed eventId,
        address indexed creator,
        string underlying,
        uint256 strike,
        uint256 premiumRate,
        uint256 expiryDate,
        uint256 initialLiquidity
    );

    /// @notice Emitted when the creator updates pool open/external-LP settings.
    event PoolSettingsUpdated(
        uint256 indexed eventId,
        bool poolOpen,
        bool allowExternalLp
    );

    /// @notice Emitted when USDC liquidity is deposited into an event pool.
    event LiquidityDeposited(
        uint256 indexed eventId,
        uint256 indexed depositId,
        address indexed lp,
        uint256 amount,
        uint256 shares
    );

    /// @notice Emitted when a hedger purchases protection on an event.
    event ProtectionPurchased(
        uint256 indexed eventId,
        uint256 indexed positionId,
        address indexed hedger,
        uint256 notional,
        uint256 premiumPaid,
        uint256 platformFee,
        uint256 totalCost
    );

    /// @notice Emitted when an event is settled by the oracle admin.
    event EventSettled(
        uint256 indexed eventId,
        uint256 settlementPrice,
        bool triggered
    );

    /// @notice Emitted when a hedger successfully claims their payout.
    event PayoutClaimed(
        uint256 indexed positionId,
        address indexed hedger,
        uint256 grossPayout,
        uint256 fee,
        uint256 netPayout
    );

    /// @notice Emitted when an LP claims earned premiums.
    event PremiumsClaimed(
        uint256 indexed depositId,
        address indexed lp,
        uint256 grossAmount,
        uint256 fee,
        uint256 netAmount
    );

    /// @notice Emitted when an LP withdraws their deposited capital after settlement.
    event CapitalWithdrawn(
        uint256 indexed depositId,
        address indexed lp,
        uint256 amount
    );

    /// @notice Emitted when the event creator withdraws their accumulated loyalty earnings.
    event CreatorEarningsWithdrawn(
        uint256 indexed eventId,
        address indexed creator,
        uint256 amount
    );

    /// @notice Emitted when the protocol owner withdraws platform fees.
    event PlatformFeesWithdrawn(
        address indexed admin,
        uint256 amount
    );

    /// @notice Emitted when fee configuration is initialised or updated.
    event FeesInitialized(
        uint256 eventCreationFee,
        uint256 hedgerFeeRate,
        uint256 hedgerPayoutFeeRate,
        uint256 lpProfitFeeRate,
        uint256 creatorLoyaltyRate
    );

    /// @notice Emitted when the oracle admin address is updated.
    event OracleAdminSet(address indexed admin);

    /// @notice Emitted when the protocol is paused.
    event Paused(address indexed by);

    /// @notice Emitted when the protocol is unpaused.
    event Unpaused(address indexed by);

    /// @notice Emitted when stranded ETH is rescued by the owner.
    event ETHRescued(address indexed to, uint256 amount);

    /// @notice Emitted when a token is added to or removed from the payment token whitelist.
    event PaymentTokenSet(address indexed token, bool allowed);

    /// @notice Emitted when the owner withdraws platform fees denominated in a specific token.
    event PlatformFeesByTokenWithdrawn(address indexed token, address indexed admin, uint256 amount);

    /// @notice Emitted when expired unclaimed payouts are recovered by the owner after the grace period.
    event ExpiredPayoutsRecovered(uint256 indexed eventId, uint256 amount);

    // ============================================================
    //                       MODIFIERS
    // ============================================================

    /// @dev Restricts access to the Diamond contract owner.
    modifier onlyOwner() {
        require(msg.sender == LibDiamond.contractOwner(), "Not owner");
        _;
    }

    /**
     * @dev Restricts access to either the designated oracle admin or the Diamond owner.
     *      The dual-path allows fallback settlement by the owner if the oracle admin
     *      key needs to be rotated or is temporarily unavailable.
     */
    modifier onlyOracleAdmin() {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(
            msg.sender == s.hedgeOracleAdmin || msg.sender == LibDiamond.contractOwner(),
            "Not oracle admin"
        );
        _;
    }

    /**
     * @dev Diamond-compatible reentrancy guard.
     *      Uses a boolean flag in AppStorage rather than a contract-level variable,
     *      which is required for the Diamond pattern (delegatecall shares storage).
     *      Reverts if called recursively. Flag is always reset, even if the body reverts.
     */
    modifier nonReentrant() {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(!s.hedgeReentrancyLock, "Reentrant call");
        s.hedgeReentrancyLock = true;
        _;
        s.hedgeReentrancyLock = false;
    }

    /**
     * @dev Emergency circuit breaker. Blocks all user-facing state-changing functions
     *      (createEvent, deposit, buyProtection, claim*, withdraw*) while the protocol
     *      is paused. Settlement via settleEvent() remains functional so events can be
     *      resolved even in a paused state.
     */
    modifier whenNotPaused() {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(!s.paused, "Protocol is paused");
        _;
    }

    // ============================================================
    //                    ADMIN FUNCTIONS
    // ============================================================

    /**
     * @notice Initialise or update the hedge fee configuration.
     * @dev Must be called once after deployment before any event can be created.
     *      Can be called again by the owner to update fees — changes apply to new
     *      events and new purchases only; in-flight events are unaffected.
     *      Sets feesInitialized = true on first (and subsequent) calls.
     *
     * @param _eventCreationFee  Flat USDC amount charged to the creator on createEvent() (6 decimals).
     * @param _hedgerFeeRate     Platform fee on notional charged to hedgers at buyProtection() (fraction of PRECISION).
     * @param _hedgerPayoutFeeRate Platform fee on gross payout deducted at claimPayout() (fraction of PRECISION).
     * @param _lpProfitFeeRate   Platform fee on premium claim deducted at claimPremiums() (fraction of PRECISION).
     * @param _creatorLoyaltyRate Share of every platform fee redirected to the event creator (fraction of PRECISION).
     */
    function initializeHedgeFees(
        uint256 _eventCreationFee,
        uint256 _hedgerFeeRate,
        uint256 _hedgerPayoutFeeRate,
        uint256 _lpProfitFeeRate,
        uint256 _creatorLoyaltyRate
    ) external onlyOwner {
        require(_hedgerFeeRate <= PRECISION, "hedgerFeeRate > 100%");
        require(_hedgerPayoutFeeRate <= PRECISION, "hedgerPayoutFeeRate > 100%");
        require(_lpProfitFeeRate <= PRECISION, "lpProfitFeeRate > 100%");
        require(_creatorLoyaltyRate <= PRECISION, "creatorLoyaltyRate > 100%");

        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        s.hedgeFeeConfig = LibAppStorage.HedgeFeeConfig({
            eventCreationFee: _eventCreationFee,
            hedgerFeeRate: _hedgerFeeRate,
            hedgerPayoutFeeRate: _hedgerPayoutFeeRate,
            lpProfitFeeRate: _lpProfitFeeRate,
            creatorLoyaltyRate: _creatorLoyaltyRate
        });
        s.feesInitialized = true;

        emit FeesInitialized(
            _eventCreationFee,
            _hedgerFeeRate,
            _hedgerPayoutFeeRate,
            _lpProfitFeeRate,
            _creatorLoyaltyRate
        );
    }

    /**
     * @notice Set the single-key oracle admin address for direct event settlement.
     * @dev The oracle admin can call settleEvent() directly. The Diamond owner always
     *      retains the ability to settle regardless of this setting (dual-path via
     *      onlyOracleAdmin modifier). Set to address(0) to disable the single-key path
     *      and require settlement exclusively via the multi-oracle OracleFacet.
     *
     * @param _admin Address that will be granted oracle admin rights. Can be address(0).
     */
    function setOracleAdmin(address _admin) external onlyOwner {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        s.hedgeOracleAdmin = _admin;
        emit OracleAdminSet(_admin);
    }

    /**
     * @notice Propose a new Diamond owner. The proposed address must call acceptOwnership().
     * @dev Two-step pattern prevents permanent lockout from a typo in the new owner address.
     *      The current owner retains all privileges until acceptOwnership() is called.
     *      Emits LibDiamond.OwnershipTransferStarted.
     *
     * @param _newOwner Address of the proposed new owner. Cannot be address(0).
     */
    function transferOwnership(address _newOwner) external onlyOwner {
        LibDiamond.transferOwnership(_newOwner);
    }

    /**
     * @notice Accept a pending ownership transfer. Must be called by the proposed new owner.
     * @dev Finalises the two-step ownership transfer initiated by transferOwnership().
     *      Reverts if called by any address other than the pending owner.
     *      Emits LibDiamond.OwnershipTransferred.
     */
    function acceptOwnership() external {
        LibDiamond.acceptOwnership();
    }

    /**
     * @notice Returns the address of the proposed new owner awaiting confirmation.
     * @dev Returns address(0) if no transfer is pending.
     * @return The pending owner address.
     */
    function pendingOwner() external view returns (address) {
        return LibDiamond.pendingOwner();
    }

    /**
     * @notice Pause all user-facing state-changing functions.
     * @dev Blocks createEvent, deposit, buyProtection, and all claim/withdraw functions.
     *      Settlement via settleEvent() and oracle operations remain unaffected so that
     *      in-flight events can still be resolved during an incident.
     *      Reverts if already paused.
     */
    function pause() external onlyOwner {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(!s.paused, "Already paused");
        s.paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Resume normal protocol operations after a pause.
     * @dev Reverts if the protocol is not currently paused.
     */
    function unpause() external onlyOwner {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(s.paused, "Not paused");
        s.paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Withdraw a specified amount of accumulated platform fees to the owner.
     * @dev Reverts if _amount exceeds the tracked platform fee balance.
     *      Uses CEI: balance decremented before transfer.
     *
     * @param _amount USDC amount to withdraw (6 decimals).
     */
    function withdrawPlatformFees(uint256 _amount) external onlyOwner nonReentrant {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(_amount <= s.hedgePlatformFeesCollected, "Exceeds collected fees");

        s.hedgePlatformFeesCollected -= _amount;
        IERC20(s.usdcToken).safeTransfer(msg.sender, _amount);

        emit PlatformFeesWithdrawn(msg.sender, _amount);
    }

    /**
     * @notice Recover USDC reserved for unclaimed hedger payouts after a grace period.
     * @dev After an event is settled, winning hedgers have PAYOUT_CLAIM_GRACE (90 days) to
     *      call claimPayout(). If they do not, their reserved payout was deducted from LP
     *      withdrawals via totalMaxPayout but never actually transferred.  This function
     *      sweeps the residual (totalMaxPayout - totalPayoutClaimed) into platform fees so
     *      that funds are never permanently locked in the contract.
     *
     *      Safety guarantees:
     *        - Requires the event to be Settled and at least 90 days past settlement.
     *        - Idempotent: sets totalMaxPayout = totalPayoutClaimed so a second call is a no-op.
     *        - Uses CEI: state updated before interaction.
     *
     * @param _eventId The settled event whose unclaimed payouts should be recovered.
     */
    function recoverExpiredPayouts(uint256 _eventId) external onlyOwner nonReentrant {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];

        require(evt.id > 0, "Event not found");
        require(evt.status == LibAppStorage.HedgeEventStatus.Settled, "Event not settled");
        require(evt.triggered, "Event did not trigger: no payouts reserved");
        require(
            block.timestamp >= evt.settledAt + 90 days,
            "Grace period not elapsed (90 days from settlement)"
        );

        uint256 reserved = evt.totalMaxPayout;
        uint256 claimed  = evt.totalPayoutClaimed;

        require(reserved > claimed, "No unclaimed payouts to recover");

        uint256 residual = reserved - claimed;

        // Mark as reconciled — further calls to this function are no-ops.
        evt.totalMaxPayout = claimed;

        // Sweep residual into platform fees for withdrawal by the owner.
        s.hedgePlatformFeesCollected += residual;
        s.platformFeesByToken[_getEventToken(s, evt)] += residual;

        emit ExpiredPayoutsRecovered(_eventId, residual);
    }

    /**
     * @notice Rescue any ETH accidentally sent to the Diamond contract.
     * @dev This contract is USDC-only. ETH has no legitimate purpose here.
     *      The Diamond's receive() reverts direct ETH sends after this fix,
     *      but this function allows recovery of any ETH present from before the upgrade.
     *      Reverts if the Diamond holds no ETH.
     *
     * @param _to Recipient address for the rescued ETH. Cannot be address(0).
     */
    function rescueETH(address payable _to) external onlyOwner nonReentrant {
        require(_to != address(0), "Zero address");
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH to rescue");
        (bool ok, ) = _to.call{value: balance}("");
        require(ok, "ETH transfer failed");
        emit ETHRescued(_to, balance);
    }

    // ============================================================
    //                    PAYMENT TOKEN MANAGEMENT (v3)
    // ============================================================

    /**
     * @notice Add or remove a stablecoin from the payment token whitelist.
     * @dev Only whitelisted tokens (or the default usdcToken) can be used when creating a new
     *      hedge event. Both USDC and USDT use 6 decimals, so all existing fee calculations
     *      work correctly without modification.
     *      Removing a token from the whitelist has no effect on events already created with it.
     *
     * @param _token   ERC-20 token contract address to whitelist or de-list.
     * @param _allowed True to allow; false to remove from whitelist.
     */
    function setAllowedPaymentToken(address _token, bool _allowed) external onlyOwner {
        require(_token != address(0), "Zero address");
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        s.allowedPaymentTokens[_token] = _allowed;
        emit PaymentTokenSet(_token, _allowed);
    }

    /**
     * @notice Returns true if `_token` is whitelisted as a valid payment token.
     * @dev The default usdcToken is always accepted regardless of this mapping.
     * @param _token The token address to check.
     * @return True if the token can be used when creating a new event.
     */
    function isAllowedPaymentToken(address _token) external view returns (bool) {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        // The global default is always implicitly allowed.
        if (_token == s.usdcToken) return true;
        return s.allowedPaymentTokens[_token];
    }

    /**
     * @notice Returns the payment token address for a specific hedge event.
     * @dev Pre-v3 events stored address(0); this returns the global usdcToken for those.
     * @param _eventId The event to query.
     * @return The ERC-20 token used for all payments in that event.
     */
    function getEventPaymentToken(uint256 _eventId) external view returns (address) {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];
        require(evt.id > 0, "Event not found");
        return _getEventToken(s, evt);
    }

    /**
     * @notice Get the accumulated platform fees for a specific payment token.
     * @param _token The payment token to query. Use the USDC address for USDC fees.
     * @return Accumulated fees in `_token` units (6 decimals for stablecoins).
     */
    function getPlatformFeesByToken(address _token) external view returns (uint256) {
        return LibAppStorage.appStorage().platformFeesByToken[_token];
    }

    /**
     * @notice Withdraw accumulated platform fees for a specific payment token.
     * @dev For USDC fees use this or the legacy withdrawPlatformFees(). For USDT or other
     *      whitelisted tokens, this is the only withdrawal path.
     *      Uses CEI: balance decremented before transfer.
     *
     * @param _token   The token whose fees to withdraw.
     * @param _amount  Amount to withdraw (6 decimals).
     */
    function withdrawPlatformFeesByToken(address _token, uint256 _amount) external onlyOwner nonReentrant {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(_amount > 0, "Amount must be > 0");
        require(_amount <= s.platformFeesByToken[_token], "Exceeds available fees for token");

        s.platformFeesByToken[_token] -= _amount;
        // Keep the legacy aggregate counter in sync when withdrawing USDC fees this way.
        if (_token == s.usdcToken && _amount <= s.hedgePlatformFeesCollected) {
            s.hedgePlatformFeesCollected -= _amount;
        }

        IERC20(_token).safeTransfer(msg.sender, _amount);
        emit PlatformFeesByTokenWithdrawn(_token, msg.sender, _amount);
    }

    // ============================================================
    //                    VIEW: PROTOCOL STATE
    // ============================================================

    /**
     * @notice Returns true if the protocol is currently paused.
     * @return True when paused, false when operational.
     */
    function isPaused() external view returns (bool) {
        return LibAppStorage.appStorage().paused;
    }

    /**
     * @notice Returns true if initializeHedgeFees() has been called at least once.
     * @dev createEvent() reverts while this returns false.
     * @return True once fees have been initialised by the owner.
     */
    function isFeesInitialized() external view returns (bool) {
        return LibAppStorage.appStorage().feesInitialized;
    }

    // ============================================================
    //                    CREATE EVENT
    // ============================================================

    /**
     * @notice Parameters for creating a new hedge event.
     *
     * @param name            Human-readable label shown in the UI.
     * @param underlying      Currency pair identifier, e.g. "USD/GHS" or "USD/NGN".
     * @param strike          Trigger price in 6-decimal units (same scale as oracle prices).
     * @param premiumRate     Premium as a fraction of notional. Uses PRECISION as denominator.
     *                        E.g. 25000 = 2.5%. Maximum = PRECISION (100%).
     * @param expiryDate      Unix timestamp at which the event expires. Must be in the future
     *                        and no more than 365 days from the current block.
     * @param allowExternalLp Whether wallets other than the creator can call deposit().
     * @param initialLiquidity USDC amount for the creator's first deposit (min 10 USDC, 6 decimals).
     * @param initialRate     Current market rate at event creation time (6 decimals).
     *                        Used to calculate predetermined payouts at buyProtection() time.
     * @param strikeAbove     Direction of the hedge.
     *                        true  = hedger wins if price rises to or above strike (USD weakens).
     *                        false = hedger wins if price falls to or below strike (USD strengthens).
     * @param paymentToken    ERC-20 stablecoin to use for all payments in this event.
     *                        Must be whitelisted via setAllowedPaymentToken(). Pass address(0)
     *                        to use the default usdcToken (always accepted, no whitelist check).
     */
    struct CreateEventParams {
        string name;
        string underlying;
        uint256 strike;
        uint256 premiumRate;
        uint256 expiryDate;
        bool allowExternalLp;
        uint256 initialLiquidity;
        uint256 initialRate;
        bool strikeAbove;
        address paymentToken;
    }

    /**
     * @notice Create a new hedge event and deposit initial liquidity.
     * @dev Fees must be initialised before this can be called.
     *      Charges the creator the event creation fee plus initialLiquidity in a single transfer.
     *      The creator's initial deposit is recorded as a standard LP deposit.
     *      Pool is created in the closed state (poolOpen = false); creator must call
     *      setPoolSettings() separately to open it for hedgers.
     *
     *      CEI order: all state changes occur before the USDC transfer.
     *
     * @param _params See {CreateEventParams}.
     * @return eventId The ID of the newly created hedge event.
     */
    function createEvent(CreateEventParams memory _params)
        external
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();

        // --- Checks ---
        require(s.feesInitialized, "Fees not initialized: call initializeHedgeFees first");
        require(bytes(_params.name).length > 0, "Name required");
        require(bytes(_params.name).length <= 128, "Name too long (max 128 bytes)");
        require(bytes(_params.underlying).length > 0, "Underlying required");
        require(bytes(_params.underlying).length <= 32, "Underlying too long (max 32 bytes)");
        require(_params.strike > 0, "Strike must be > 0");
        require(_params.premiumRate > 0, "Premium rate must be > 0");
        require(_params.premiumRate <= PRECISION, "Premium rate cannot exceed 100%");
        require(_params.expiryDate > block.timestamp, "Expiry must be in future");
        require(
            _params.expiryDate <= block.timestamp + 365 days,
            "Expiry cannot exceed 365 days from now"
        );
        require(_params.initialLiquidity >= 10 * PRECISION, "Min initial liquidity: 10 USDC");
        require(_params.initialRate > 0, "Initial rate must be > 0");
        if (_params.strikeAbove) {
            require(
                _params.strike > _params.initialRate,
                "Strike must be above current rate for upward hedge"
            );
        } else {
            require(
                _params.strike < _params.initialRate,
                "Strike must be below current rate for downward hedge"
            );
        }

        // Resolve and validate payment token.
        // address(0) silently uses the default usdcToken; any other address must be whitelisted.
        address token = _params.paymentToken == address(0)
            ? s.usdcToken
            : _params.paymentToken;
        if (token != s.usdcToken) {
            require(s.allowedPaymentTokens[token], "Payment token not whitelisted");
        }

        // --- Effects ---
        uint256 creationFee = s.hedgeFeeConfig.eventCreationFee;
        s.hedgePlatformFeesCollected += creationFee;
        s.platformFeesByToken[token] += creationFee;

        uint256 eventId = ++s.hedgeEventCounter;
        s.totalHedgeEvents++;

        _initHedgeEvent(s, eventId, _params, token);

        uint256 depositId = _createInitialDeposit(s, eventId, _params.initialLiquidity);

        // --- Interactions ---
        uint256 totalAmount = creationFee + _params.initialLiquidity;
        IERC20(token).safeTransferFrom(msg.sender, address(this), totalAmount);

        emit HedgeEventCreated(
            eventId, msg.sender, _params.underlying, _params.strike,
            _params.premiumRate, _params.expiryDate, _params.initialLiquidity
        );
        emit LiquidityDeposited(
            eventId, depositId, msg.sender,
            _params.initialLiquidity,
            s.hedgeLpDeposits[depositId].shares
        );

        return eventId;
    }

    /// @dev Initialises the HedgeEvent storage struct and registers the creator's event ID.
    ///      `_resolvedToken` is the final payment token address already validated by createEvent().
    function _initHedgeEvent(
        LibAppStorage.AppStorage storage s,
        uint256 eventId,
        CreateEventParams memory _params,
        address _resolvedToken
    ) internal {
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[eventId];
        evt.id = eventId;
        evt.creator = msg.sender;
        evt.name = _params.name;
        evt.underlying = _params.underlying;
        evt.strike = _params.strike;
        evt.premiumRate = _params.premiumRate;
        evt.expiryDate = _params.expiryDate;
        evt.status = LibAppStorage.HedgeEventStatus.Open;
        evt.poolOpen = false;
        evt.allowExternalLp = _params.allowExternalLp;
        evt.totalLiquidity = _params.initialLiquidity;
        evt.lpCount = 1;
        evt.initialRate = _params.initialRate;
        evt.strikeAbove = _params.strikeAbove;
        evt.createdAt = block.timestamp;
        // Store the resolved token. For USDC events this is s.usdcToken; zero address is
        // never stored here — the resolution already happened in createEvent().
        evt.paymentToken = _resolvedToken;
        s.hedgeCreatorEventIds[msg.sender].push(eventId);
    }

    /**
     * @dev Return the payment token for an event.
     *      Pre-v3 events have paymentToken == address(0); this falls back to the global usdcToken
     *      so all existing events continue working correctly without any migration.
     */
    function _getEventToken(
        LibAppStorage.AppStorage storage s,
        LibAppStorage.HedgeEvent storage evt
    ) internal view returns (address) {
        return evt.paymentToken == address(0) ? s.usdcToken : evt.paymentToken;
    }

    /**
     * @dev Creates the creator's initial LP deposit record with shares calculated at
     *      the base rate (amount * SHARES_PRECISION / PRECISION) since the pool is empty.
     * @return depositId The ID of the newly created deposit record.
     */
    function _createInitialDeposit(
        LibAppStorage.AppStorage storage s,
        uint256 eventId,
        uint256 amount
    ) internal returns (uint256) {
        uint256 depositId = ++s.hedgeLpDepositCounter;
        LibAppStorage.HedgeLpDeposit storage dep = s.hedgeLpDeposits[depositId];
        dep.id = depositId;
        dep.eventId = eventId;
        dep.lp = msg.sender;
        dep.amount = amount;
        dep.shares = amount * SHARES_PRECISION / PRECISION;
        dep.createdAt = block.timestamp;
        s.hedgeEventDepositIds[eventId].push(depositId);
        s.lpDepositIds[msg.sender].push(depositId);
        return depositId;
    }

    // ============================================================
    //                    POOL CONTROLS
    // ============================================================

    /**
     * @notice Toggle whether the pool accepts new hedger positions and/or external LP deposits.
     * @dev Only the event creator can call this. Event must still be Open.
     *      Pool starts closed after createEvent() — call setPoolSettings(true, ...) to open.
     *      Toggling poolOpen does not affect existing positions or deposits.
     *
     * @param _eventId       The event to configure.
     * @param _poolOpen      True to allow new hedgers to buyProtection(); false to block new entries.
     * @param _allowExternalLp True to allow non-creator wallets to deposit(); false for creator-only.
     */
    function setPoolSettings(
        uint256 _eventId,
        bool _poolOpen,
        bool _allowExternalLp
    ) external {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];

        require(evt.id > 0, "Event not found");
        require(msg.sender == evt.creator, "Not creator");
        require(evt.status == LibAppStorage.HedgeEventStatus.Open, "Event not open");

        evt.poolOpen = _poolOpen;
        evt.allowExternalLp = _allowExternalLp;

        emit PoolSettingsUpdated(_eventId, _poolOpen, _allowExternalLp);
    }

    // ============================================================
    //                    LP DEPOSIT
    // ============================================================

    /**
     * @notice Deposit USDC liquidity into a hedge event pool and receive proportional shares.
     * @dev Shares represent a proportional claim on pool liquidity and premium distributions.
     *      Share price at deposit time = totalLiquidity / totalShares (Balancer-style).
     *      If the pool has no liquidity, shares are minted at the base rate.
     *      Deposits are capped at MAX_DEPOSITS_PER_EVENT (200) to bound the gas cost of
     *      _distributePremiumToLps(), which iterates over all deposits at each buyProtection().
     *
     *      CEI order: all state changes occur before the USDC transfer.
     *
     * @param _eventId The event pool to deposit into.
     * @param _amount  USDC amount to deposit (min 10 USDC, 6 decimals).
     * @return depositId The ID of the newly created LP deposit record.
     */
    function deposit(uint256 _eventId, uint256 _amount)
        external
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];

        // --- Checks ---
        require(evt.id > 0, "Event not found");
        require(evt.status == LibAppStorage.HedgeEventStatus.Open, "Event not open");
        require(_amount >= 10 * PRECISION, "Min deposit: 10 USDC");
        require(
            s.hedgeEventDepositIds[_eventId].length < MAX_DEPOSITS_PER_EVENT,
            "Max LP deposits reached for this event"
        );

        bool isCreator = msg.sender == evt.creator;
        require(isCreator || evt.allowExternalLp, "Pool is private");

        // --- Effects ---
        uint256 shares;
        if (evt.totalLiquidity == 0) {
            shares = _amount * SHARES_PRECISION / PRECISION;
        } else {
            uint256 totalShares = _getTotalShares(s, _eventId);
            shares = (_amount * totalShares) / evt.totalLiquidity;
        }

        evt.totalLiquidity += _amount;
        evt.lpCount++;

        uint256 depositId = ++s.hedgeLpDepositCounter;
        LibAppStorage.HedgeLpDeposit storage dep = s.hedgeLpDeposits[depositId];
        dep.id = depositId;
        dep.eventId = _eventId;
        dep.lp = msg.sender;
        dep.amount = _amount;
        dep.shares = shares;
        dep.createdAt = block.timestamp;

        s.hedgeEventDepositIds[_eventId].push(depositId);
        s.lpDepositIds[msg.sender].push(depositId);

        // --- Interactions ---
        IERC20(_getEventToken(s, evt)).safeTransferFrom(msg.sender, address(this), _amount);

        emit LiquidityDeposited(_eventId, depositId, msg.sender, _amount, shares);

        return depositId;
    }

    // ============================================================
    //                    BUY PROTECTION
    // ============================================================

    /**
     * @notice Purchase parametric FX protection on an open hedge event.
     * @dev The payout is fully predetermined at the moment of purchase — the hedger knows
     *      exactly what they will receive if the strike is touched:
     *
     *        upward hedge   : payout = notional * (strike - initialRate) / initialRate
     *        downward hedge : payout = notional * (initialRate - strike) / initialRate
     *
     *      The pool must hold enough free liquidity (totalLiquidity - totalMaxPayout) to
     *      cover the predetermined payout. If triggered at settlement, the payout is drawn
     *      from LP capital proportionally.
     *
     *      Cost breakdown charged to the hedger:
     *        premium      = notional * premiumRate / PRECISION  (distributed to LPs immediately)
     *        platform fee = notional * hedgerFeeRate / PRECISION (split: creatorLoyalty + platform)
     *        total cost   = premium + platform fee
     *
     *      Positions are capped at MAX_POSITIONS_PER_EVENT (500) to bound the gas cost
     *      of settleEvent(), which iterates over all positions.
     *
     *      CEI order: all state changes (including premium distribution) occur before
     *      the USDC transfer.
     *
     * @param _eventId  The event to buy protection on.
     * @param _notional Coverage amount in USDC (min 10 USDC, 6 decimals).
     * @return positionId The ID of the newly created hedge position.
     */
    function buyProtection(uint256 _eventId, uint256 _notional)
        external
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];

        // --- Checks ---
        require(evt.id > 0, "Event not found");
        require(evt.status == LibAppStorage.HedgeEventStatus.Open, "Event not open");
        require(evt.poolOpen, "Pool not open for hedging");
        require(block.timestamp < evt.expiryDate, "Event expired");
        require(_notional >= 10 * PRECISION, "Min notional: 10 USDC");
        require(
            s.hedgeEventPositionIds[_eventId].length < MAX_POSITIONS_PER_EVENT,
            "Max positions reached for this event"
        );

        uint256 priceDelta = evt.strikeAbove
            ? evt.strike - evt.initialRate
            : evt.initialRate - evt.strike;
        uint256 predeterminedPayout = (_notional * priceDelta) / evt.initialRate;

        uint256 availableLiquidity = evt.totalLiquidity - evt.totalMaxPayout;
        require(predeterminedPayout <= availableLiquidity, "Insufficient pool liquidity for payout");

        uint256 premium = (_notional * evt.premiumRate) / PRECISION;
        uint256 platformFee = (_notional * s.hedgeFeeConfig.hedgerFeeRate) / PRECISION;
        uint256 totalCost = premium + platformFee;

        // --- Effects ---
        evt.totalExposure += _notional;
        evt.totalMaxPayout += predeterminedPayout;
        evt.totalPremiums += premium;
        evt.hedgerCount++;

        uint256 positionId = ++s.hedgePositionCounter;
        LibAppStorage.HedgePosition storage pos = s.hedgePositions[positionId];
        pos.id = positionId;
        pos.eventId = _eventId;
        pos.hedger = msg.sender;
        pos.notional = _notional;
        pos.premiumPaid = premium;
        pos.platformFeePaid = platformFee;
        pos.payoutAmount = predeterminedPayout;
        pos.status = LibAppStorage.HedgePositionStatus.Active;
        pos.createdAt = block.timestamp;

        s.hedgeEventPositionIds[_eventId].push(positionId);
        s.hedgerPositionIds[msg.sender].push(positionId);

        _distributePremiumToLps(s, _eventId, premium);

        uint256 creatorReward = (platformFee * s.hedgeFeeConfig.creatorLoyaltyRate) / PRECISION;
        evt.creatorEarnings += creatorReward;
        uint256 netPlatformFee = platformFee - creatorReward;
        s.hedgePlatformFeesCollected += netPlatformFee;

        address token = _getEventToken(s, evt);
        s.platformFeesByToken[token] += netPlatformFee;

        // --- Interactions ---
        IERC20(token).safeTransferFrom(msg.sender, address(this), totalCost);

        emit ProtectionPurchased(
            _eventId, positionId, msg.sender,
            _notional, premium, platformFee, totalCost
        );

        return positionId;
    }

    // ============================================================
    //                    SETTLEMENT
    // ============================================================

    /**
     * @notice Settle a hedge event by providing the final FX rate.
     * @dev Can be called by the designated oracle admin or the Diamond owner.
     *      Determines whether the strike was touched (one-touch logic):
     *        strikeAbove = true  : triggered when settlementPrice >= strike
     *        strikeAbove = false : triggered when settlementPrice <= strike
     *
     *      If triggered: all Active positions become Claimable.
     *      If not triggered: all Active positions become Expired with payoutAmount = 0.
     *
     *      The position loop is bounded by MAX_POSITIONS_PER_EVENT (enforced in buyProtection).
     *
     *      This function intentionally does NOT have whenNotPaused so events can be resolved
     *      even during a protocol pause.
     *
     * @param _eventId         The event to settle.
     * @param _settlementPrice The final FX rate at settlement time (6 decimals).
     */
    function settleEvent(uint256 _eventId, uint256 _settlementPrice) external onlyOracleAdmin {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];

        require(evt.id > 0, "Event not found");
        require(evt.status == LibAppStorage.HedgeEventStatus.Open, "Already settled");
        require(_settlementPrice > 0, "Invalid price");

        bool triggered = evt.strikeAbove
            ? _settlementPrice >= evt.strike
            : _settlementPrice <= evt.strike;

        evt.status = LibAppStorage.HedgeEventStatus.Settled;
        evt.settlementPrice = _settlementPrice;
        evt.triggered = triggered;
        evt.settledAt = block.timestamp;

        uint256[] storage positionIds = s.hedgeEventPositionIds[_eventId];
        for (uint256 i = 0; i < positionIds.length; i++) {
            LibAppStorage.HedgePosition storage pos = s.hedgePositions[positionIds[i]];
            if (pos.status != LibAppStorage.HedgePositionStatus.Active) continue;

            if (triggered) {
                pos.status = LibAppStorage.HedgePositionStatus.Claimable;
            } else {
                pos.payoutAmount = 0;
                pos.status = LibAppStorage.HedgePositionStatus.Expired;
            }
        }

        emit EventSettled(_eventId, _settlementPrice, triggered);
    }

    // ============================================================
    //                    HEDGER CLAIM PAYOUT
    // ============================================================

    /**
     * @notice Claim a winning payout after the event has been settled in the hedger's favour.
     * @dev Position must be in Claimable or SettledWin status.
     *      A platform fee (hedgerPayoutFeeRate) is deducted from the gross payout.
     *      A share of that fee (creatorLoyaltyRate) is credited to the event creator.
     *      Uses CEI: state is updated before the USDC transfer.
     *
     * @param _positionId The ID of the hedger's position to claim.
     */
    function claimPayout(uint256 _positionId) external nonReentrant {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgePosition storage pos = s.hedgePositions[_positionId];

        require(pos.id > 0, "Position not found");
        require(msg.sender == pos.hedger, "Not your position");
        require(!pos.claimed, "Already claimed");
        require(
            pos.status == LibAppStorage.HedgePositionStatus.Claimable ||
            pos.status == LibAppStorage.HedgePositionStatus.SettledWin,
            "Not eligible for payout"
        );
        require(pos.payoutAmount > 0, "No payout");

        uint256 grossPayout = pos.payoutAmount;
        uint256 payoutFee = (grossPayout * s.hedgeFeeConfig.hedgerPayoutFeeRate) / PRECISION;
        uint256 netPayout = grossPayout - payoutFee;

        uint256 creatorReward = (payoutFee * s.hedgeFeeConfig.creatorLoyaltyRate) / PRECISION;
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[pos.eventId];
        evt.creatorEarnings += creatorReward;
        uint256 netPayoutFee = payoutFee - creatorReward;
        s.hedgePlatformFeesCollected += netPayoutFee;

        address token = _getEventToken(s, evt);
        s.platformFeesByToken[token] += netPayoutFee;

        // Track total tokens actually paid out for this event (used by recoverExpiredPayouts).
        evt.totalPayoutClaimed += grossPayout;

        pos.claimed = true;
        pos.status = LibAppStorage.HedgePositionStatus.Claimed;

        IERC20(token).safeTransfer(msg.sender, netPayout);

        emit PayoutClaimed(_positionId, msg.sender, grossPayout, payoutFee, netPayout);
    }

    // ============================================================
    //                    LP CLAIM PREMIUMS
    // ============================================================

    /**
     * @notice Claim all unclaimed premiums earned by an LP deposit.
     * @dev Claimable amount = premiumsEarned - premiumsClaimed.
     *      Premiums are distributed into premiumsEarned on each buyProtection() call
     *      proportionally to the LP's share of the pool.
     *      A platform fee (lpProfitFeeRate) is deducted from the claimable amount.
     *      A share of that fee (creatorLoyaltyRate) is credited to the event creator.
     *      Uses CEI: premiumsClaimed updated before the USDC transfer.
     *      Can be called before or after event settlement.
     *
     * @param _depositId The LP deposit to claim premiums for.
     */
    function claimPremiums(uint256 _depositId) external nonReentrant {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeLpDeposit storage dep = s.hedgeLpDeposits[_depositId];

        require(dep.id > 0, "Deposit not found");
        require(msg.sender == dep.lp, "Not your deposit");

        uint256 claimable = dep.premiumsEarned - dep.premiumsClaimed;
        require(claimable > 0, "No premiums to claim");

        uint256 lpFee = (claimable * s.hedgeFeeConfig.lpProfitFeeRate) / PRECISION;
        uint256 netAmount = claimable - lpFee;

        uint256 creatorReward = (lpFee * s.hedgeFeeConfig.creatorLoyaltyRate) / PRECISION;
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[dep.eventId];
        evt.creatorEarnings += creatorReward;
        uint256 netLpFee = lpFee - creatorReward;
        s.hedgePlatformFeesCollected += netLpFee;

        address token = _getEventToken(s, evt);
        s.platformFeesByToken[token] += netLpFee;

        dep.premiumsClaimed += claimable;

        IERC20(token).safeTransfer(msg.sender, netAmount);

        emit PremiumsClaimed(_depositId, msg.sender, claimable, lpFee, netAmount);
    }

    // ============================================================
    //                    LP WITHDRAW CAPITAL
    // ============================================================

    /**
     * @notice Withdraw deposited capital after an event has been settled or expired.
     * @dev Capital is locked while the event is Open to back active hedger positions.
     *      After settlement, capital is returned net of the LP's proportional share of
     *      actual payouts owed to winning hedgers (only if triggered = true).
     *
     *      Payout deduction formula (single-step to avoid double-division precision loss):
     *        lpPayoutShare = totalMaxPayout * dep.amount / totalLiquidity
     *
     *      Uses CEI: withdrawn flag set before the USDC transfer.
     *
     * @param _depositId The LP deposit to withdraw.
     */
    function withdrawCapital(uint256 _depositId) external nonReentrant {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeLpDeposit storage dep = s.hedgeLpDeposits[_depositId];

        require(dep.id > 0, "Deposit not found");
        require(msg.sender == dep.lp, "Not your deposit");
        require(!dep.withdrawn, "Already withdrawn");

        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[dep.eventId];
        require(
            evt.status != LibAppStorage.HedgeEventStatus.Open,
            "Cannot withdraw while event is active"
        );

        dep.withdrawn = true;
        dep.withdrawnAt = block.timestamp;

        uint256 withdrawAmount = dep.amount;

        if (evt.triggered && evt.totalMaxPayout > 0 && evt.totalLiquidity > 0) {
            // Single-step calculation avoids compounding truncation from two divisions.
            uint256 lpPayoutShare = (evt.totalMaxPayout * dep.amount) / evt.totalLiquidity;
            if (lpPayoutShare > withdrawAmount) {
                withdrawAmount = 0;
            } else {
                withdrawAmount -= lpPayoutShare;
            }
        }

        if (withdrawAmount > 0) {
            IERC20(_getEventToken(s, evt)).safeTransfer(msg.sender, withdrawAmount);
        }

        emit CapitalWithdrawn(_depositId, msg.sender, withdrawAmount);
    }

    // ============================================================
    //                    CREATOR WITHDRAW EARNINGS
    // ============================================================

    /**
     * @notice Withdraw accumulated creator loyalty earnings for a specific event.
     * @dev Creator earnings accumulate on each buyProtection() and each claim call
     *      as a percentage (creatorLoyaltyRate) of every platform fee collected.
     *      Uses CEI: earnings zeroed before the USDC transfer.
     *
     * @param _eventId The event whose creator earnings should be withdrawn.
     */
    function withdrawCreatorEarnings(uint256 _eventId) external nonReentrant {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];

        require(evt.id > 0, "Event not found");
        require(msg.sender == evt.creator, "Not creator");
        require(evt.creatorEarnings > 0, "No earnings");

        uint256 amount = evt.creatorEarnings;
        evt.creatorEarnings = 0;

        IERC20(_getEventToken(s, evt)).safeTransfer(msg.sender, amount);

        emit CreatorEarningsWithdrawn(_eventId, msg.sender, amount);
    }

    // ============================================================
    //                    VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Get the core parameters of a hedge event.
     * @param _eventId The event ID to query.
     * @return id              Unique event identifier.
     * @return creator         Address that created the event.
     * @return name            Human-readable event name.
     * @return underlying      Currency pair, e.g. "USD/GHS".
     * @return strike          Trigger price (6 decimals).
     * @return premiumRate     Premium rate (PRECISION denominator).
     * @return expiryDate      Unix timestamp of event expiry.
     * @return status          Current lifecycle status.
     * @return poolOpen        Whether new hedger positions are accepted.
     * @return allowExternalLp Whether non-creator LPs can deposit.
     * @return initialRate     Market rate at event creation (6 decimals).
     * @return strikeAbove     true = upward hedge; false = downward hedge.
     */
    function getHedgeEventCore(uint256 _eventId) external view returns (
        uint256 id,
        address creator,
        string memory name,
        string memory underlying,
        uint256 strike,
        uint256 premiumRate,
        uint256 expiryDate,
        LibAppStorage.HedgeEventStatus status,
        bool poolOpen,
        bool allowExternalLp,
        uint256 initialRate,
        bool strikeAbove
    ) {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];
        return (
            evt.id, evt.creator, evt.name, evt.underlying,
            evt.strike, evt.premiumRate, evt.expiryDate, evt.status,
            evt.poolOpen, evt.allowExternalLp, evt.initialRate, evt.strikeAbove
        );
    }

    /**
     * @notice Get settlement results and pool statistics for a hedge event.
     * @param _eventId The event ID to query.
     * @return settlementPrice The FX rate posted at settlement (0 if not yet settled).
     * @return triggered       Whether the strike was touched and hedgers won.
     * @return settledAt       Unix timestamp of settlement (0 if not yet settled).
     * @return creatorEarnings Unclaimed creator loyalty earnings (USDC, 6 decimals).
     * @return totalLiquidity  Total USDC deposited by all LPs (6 decimals).
     * @return totalExposure   Sum of all hedger notionals (6 decimals).
     * @return totalPremiums   Sum of all premiums collected from hedgers (6 decimals).
     * @return lpCount         Historical count of LP deposits (not unique LPs).
     * @return hedgerCount     Total number of hedger positions created.
     * @return totalMaxPayout  Total predetermined payout reserved from pool liquidity (6 decimals).
     */
    function getHedgeEventStats(uint256 _eventId) external view returns (
        uint256 settlementPrice,
        bool triggered,
        uint256 settledAt,
        uint256 creatorEarnings,
        uint256 totalLiquidity,
        uint256 totalExposure,
        uint256 totalPremiums,
        uint256 lpCount,
        uint256 hedgerCount,
        uint256 totalMaxPayout
    ) {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];
        return (
            evt.settlementPrice, evt.triggered, evt.settledAt,
            evt.creatorEarnings, evt.totalLiquidity, evt.totalExposure,
            evt.totalPremiums, evt.lpCount, evt.hedgerCount,
            evt.totalMaxPayout
        );
    }

    /**
     * @notice Get full details of a hedger position.
     * @param _positionId The position ID to query.
     * @return id              Unique position identifier.
     * @return eventId         The hedge event this position belongs to.
     * @return hedger          Owner of the position.
     * @return notional        Coverage amount (USDC, 6 decimals).
     * @return premiumPaid     Premium paid by the hedger (USDC, 6 decimals).
     * @return platformFeePaid Platform fee paid at purchase (USDC, 6 decimals).
     * @return payoutAmount    Predetermined payout if triggered (USDC, 6 decimals). 0 if expired.
     * @return status          Current position lifecycle status.
     * @return claimed         Whether claimPayout() has been successfully called.
     */
    function getHedgePosition(uint256 _positionId) external view returns (
        uint256 id,
        uint256 eventId,
        address hedger,
        uint256 notional,
        uint256 premiumPaid,
        uint256 platformFeePaid,
        uint256 payoutAmount,
        LibAppStorage.HedgePositionStatus status,
        bool claimed
    ) {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgePosition storage pos = s.hedgePositions[_positionId];
        return (
            pos.id, pos.eventId, pos.hedger, pos.notional,
            pos.premiumPaid, pos.platformFeePaid, pos.payoutAmount,
            pos.status, pos.claimed
        );
    }

    /**
     * @notice Get full details of an LP deposit.
     * @param _depositId The deposit ID to query.
     * @return id              Unique deposit identifier.
     * @return eventId         The hedge event this deposit belongs to.
     * @return lp              Owner of the deposit.
     * @return amount          USDC deposited (6 decimals).
     * @return shares          Share tokens received, representing proportional pool ownership.
     * @return premiumsEarned  Cumulative premiums allocated to this deposit (6 decimals).
     * @return premiumsClaimed Cumulative premiums already claimed (6 decimals).
     * @return withdrawn       Whether withdrawCapital() has been called for this deposit.
     */
    function getHedgeLpDeposit(uint256 _depositId) external view returns (
        uint256 id,
        uint256 eventId,
        address lp,
        uint256 amount,
        uint256 shares,
        uint256 premiumsEarned,
        uint256 premiumsClaimed,
        bool withdrawn
    ) {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeLpDeposit storage dep = s.hedgeLpDeposits[_depositId];
        return (
            dep.id, dep.eventId, dep.lp, dep.amount,
            dep.shares, dep.premiumsEarned, dep.premiumsClaimed,
            dep.withdrawn
        );
    }

    /**
     * @notice Get all hedger position IDs for a given event.
     * @param _eventId The event to query.
     * @return Array of position IDs, in order of creation.
     */
    function getEventPositionIds(uint256 _eventId) external view returns (uint256[] memory) {
        return LibAppStorage.appStorage().hedgeEventPositionIds[_eventId];
    }

    /**
     * @notice Get all LP deposit IDs for a given event.
     * @param _eventId The event to query.
     * @return Array of deposit IDs, in order of creation.
     */
    function getEventDepositIds(uint256 _eventId) external view returns (uint256[] memory) {
        return LibAppStorage.appStorage().hedgeEventDepositIds[_eventId];
    }

    /**
     * @notice Get all event IDs created by a specific address.
     * @param _creator The creator address to query.
     * @return Array of event IDs, in order of creation.
     */
    function getCreatorEventIds(address _creator) external view returns (uint256[] memory) {
        return LibAppStorage.appStorage().hedgeCreatorEventIds[_creator];
    }

    /**
     * @notice Get all position IDs belonging to a specific hedger.
     * @param _hedger The hedger address to query.
     * @return Array of position IDs across all events, in order of creation.
     */
    function getHedgerPositionIds(address _hedger) external view returns (uint256[] memory) {
        return LibAppStorage.appStorage().hedgerPositionIds[_hedger];
    }

    /**
     * @notice Get all deposit IDs belonging to a specific LP.
     * @param _lp The LP address to query.
     * @return Array of deposit IDs across all events, in order of creation.
     */
    function getLpDepositIds(address _lp) external view returns (uint256[] memory) {
        return LibAppStorage.appStorage().lpDepositIds[_lp];
    }

    /**
     * @notice Get the current fee configuration.
     * @return eventCreationFee   Flat USDC fee charged on createEvent() (6 decimals).
     * @return hedgerFeeRate      Platform fee on notional at buyProtection() (fraction of PRECISION).
     * @return hedgerPayoutFeeRate Platform fee on gross payout at claimPayout() (fraction of PRECISION).
     * @return lpProfitFeeRate    Platform fee on premium claim at claimPremiums() (fraction of PRECISION).
     * @return creatorLoyaltyRate Share of each platform fee redirected to event creator (fraction of PRECISION).
     */
    function getHedgeFeeConfig() external view returns (
        uint256 eventCreationFee,
        uint256 hedgerFeeRate,
        uint256 hedgerPayoutFeeRate,
        uint256 lpProfitFeeRate,
        uint256 creatorLoyaltyRate
    ) {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        return (
            s.hedgeFeeConfig.eventCreationFee,
            s.hedgeFeeConfig.hedgerFeeRate,
            s.hedgeFeeConfig.hedgerPayoutFeeRate,
            s.hedgeFeeConfig.lpProfitFeeRate,
            s.hedgeFeeConfig.creatorLoyaltyRate
        );
    }

    /**
     * @notice Get the total platform fees accumulated and not yet withdrawn.
     * @return Total unclaimed platform fees in USDC (6 decimals).
     */
    function getHedgePlatformFees() external view returns (uint256) {
        return LibAppStorage.appStorage().hedgePlatformFeesCollected;
    }

    /**
     * @notice Get the total number of hedge events ever created.
     * @return Cumulative event count (includes settled and expired events).
     */
    function getTotalHedgeEvents() external view returns (uint256) {
        return LibAppStorage.appStorage().totalHedgeEvents;
    }

    /**
     * @notice Get pool liquidity utilisation metrics for a hedge event.
     * @param _eventId The event to query.
     * @return totalLiquidity     Total USDC deposited by all LPs (6 decimals).
     * @return totalExposure      Sum of all hedger notionals bought (6 decimals).
     * @return availableCapacity  Free liquidity not yet reserved for payouts (6 decimals).
     * @return utilizationPercent Fraction of liquidity reserved, scaled by PRECISION * 100.
     *                            E.g. 5000000 = 5% utilisation (PRECISION = 1e6).
     */
    function getPoolUtilization(uint256 _eventId) external view returns (
        uint256 totalLiquidity,
        uint256 totalExposure,
        uint256 availableCapacity,
        uint256 utilizationPercent
    ) {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];

        uint256 available = evt.totalLiquidity > evt.totalMaxPayout
            ? evt.totalLiquidity - evt.totalMaxPayout
            : 0;

        uint256 utilization = evt.totalLiquidity > 0
            ? (evt.totalMaxPayout * 100 * PRECISION) / evt.totalLiquidity
            : 0;

        return (evt.totalLiquidity, evt.totalExposure, available, utilization);
    }

    // ============================================================
    //                    INTERNAL HELPERS
    // ============================================================

    /**
     * @dev Distribute a premium amount proportionally to all active (non-withdrawn) LPs
     *      based on their share of the total pool shares.
     *
     *      The loop is bounded by MAX_DEPOSITS_PER_EVENT (enforced in deposit()).
     *      Minor integer rounding dust (1–N wei) may accumulate in the contract
     *      over many buyProtection() calls; this is non-exploitable and negligible.
     *
     * @param s        Reference to AppStorage.
     * @param _eventId The event whose LP deposits receive the premium.
     * @param _premium Total premium to distribute (USDC, 6 decimals).
     */
    function _distributePremiumToLps(
        LibAppStorage.AppStorage storage s,
        uint256 _eventId,
        uint256 _premium
    ) internal {
        uint256[] storage depositIds = s.hedgeEventDepositIds[_eventId];
        uint256 totalShares = _getTotalShares(s, _eventId);

        if (totalShares == 0) return;

        for (uint256 i = 0; i < depositIds.length; i++) {
            LibAppStorage.HedgeLpDeposit storage dep = s.hedgeLpDeposits[depositIds[i]];
            if (dep.withdrawn) continue;

            uint256 lpShare = (_premium * dep.shares) / totalShares;
            dep.premiumsEarned += lpShare;
        }
    }

    /**
     * @dev Calculate the sum of shares held by all non-withdrawn LP deposits for an event.
     *      Used as the denominator when distributing premiums proportionally.
     *      The loop is bounded by MAX_DEPOSITS_PER_EVENT (enforced in deposit()).
     *
     * @param s        Reference to AppStorage.
     * @param _eventId The event to calculate total shares for.
     * @return total   Sum of shares across all active (non-withdrawn) deposits.
     */
    function _getTotalShares(
        LibAppStorage.AppStorage storage s,
        uint256 _eventId
    ) internal view returns (uint256) {
        uint256[] storage depositIds = s.hedgeEventDepositIds[_eventId];
        uint256 total = 0;

        for (uint256 i = 0; i < depositIds.length; i++) {
            LibAppStorage.HedgeLpDeposit storage dep = s.hedgeLpDeposits[depositIds[i]];
            if (!dep.withdrawn) {
                total += dep.shares;
            }
        }

        return total;
    }
}
