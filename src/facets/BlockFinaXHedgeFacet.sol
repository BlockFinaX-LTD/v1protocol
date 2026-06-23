// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
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

    /// @dev Hard cap on LP deposits per event. Enforced in deposit().
    uint256 constant MAX_DEPOSITS_PER_EVENT = 200;

    /// @dev Precision multiplier for the MasterChef accPremiumPerShare accumulator.
    ///      1e18 gives sufficient resolution for pools as small as $100 with $1 premiums:
    ///        accPremiumPerShare += 1e6 * 1e18 / 1e20 = 1e4  (no precision loss)
    ///      Safe from overflow: max shares (~1e22) * max acc (~1e16) = 1e38 << uint256 max.
    uint256 constant ACC_PREMIUM_MULTIPLIER = 1e18;

    /// @dev Maximum age of a pricing-engine quote signature, in seconds. A quote signed
    ///      more than this long ago is rejected — protects against an attacker hoarding
    ///      old signatures and replaying them after market conditions have moved.
    ///      120s is enough headroom for slow Base/BSC blocks plus user click latency
    ///      while still bounding the exposure window if the engine key is compromised.
    uint256 constant QUOTE_MAX_AGE_SECONDS = 120;

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

    /// @notice Emitted when the single-key settlement path is permanently disabled.
    ///         After this event, all settlement must go through OracleFacet.
    event OracleV2Activated();

    /// @notice Emitted when the protocol is paused.
    event Paused(address indexed by);

    /// @notice Emitted when the protocol is unpaused.
    event Unpaused(address indexed by);

    /// @notice Emitted when stranded ETH is rescued by the owner.
    event ETHRescued(address indexed to, uint256 amount);
    /// @notice Emitted when a non-payment ERC20 token is rescued from the Diamond by the owner.
    event ERC20Rescued(address indexed token, address indexed to, uint256 amount);

    /// @notice Emitted when a token is added to or removed from the payment token whitelist.
    event PaymentTokenSet(address indexed token, bool allowed);

    /// @notice Emitted when the owner withdraws platform fees denominated in a specific token.
    event PlatformFeesByTokenWithdrawn(address indexed token, address indexed admin, uint256 amount);

    /// @notice Emitted when expired unclaimed payouts are recovered by the owner after the grace period.
    event ExpiredPayoutsRecovered(uint256 indexed eventId, uint256 amount);

    /// @notice Emitted when the on-chain pricing-engine signer address is set or rotated.
    /// @dev    Setting `_signer` to address(0) DISABLES signature checks and reverts the
    ///         protocol to legacy mode where any premium can be passed in createEvent().
    ///         Setting it to a non-zero address ENFORCES signature verification on every
    ///         subsequent createEvent() call.
    event PricingEngineSignerSet(address indexed previousSigner, address indexed newSigner);

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
     *
     *      H-1 fix: guard is enforced here in the modifier (single point of enforcement)
     *      rather than duplicated inside settleEvent(). Once activateOracleV2() is called,
     *      any attempt to use the single-key path reverts before executing any logic.
     */
    modifier onlyOracleAdmin() {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(!s.oracleV2Active, "Single-key settlement disabled: use OracleFacet");
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
        // H002: cap individual rates to sensible maxima to prevent misconfiguration.
        // Creation fee capped at $1,000 expressed in the highest-precision token (18 dec).
        // For 6-dec USDC: max 1_000 * 1e6 = 1e9. For 18-dec USDT: max 1_000 * 1e18 = 1e21.
        // Using 1_000 * 1e18 as the universal cap — well above any 6-dec USDC fee.
        require(_eventCreationFee <= 1_000 * 1e18, "Creation fee exceeds $1000 cap");
        // Percentage rates capped at 10% (100_000 / 1e6). Creator loyalty capped at 50% (500_000 / 1e6).
        require(_hedgerFeeRate <= 100_000, "hedgerFeeRate exceeds 10% cap");
        require(_hedgerPayoutFeeRate <= 100_000, "hedgerPayoutFeeRate exceeds 10% cap");
        require(_lpProfitFeeRate <= 100_000, "lpProfitFeeRate exceeds 10% cap");
        require(_creatorLoyaltyRate <= 500_000, "creatorLoyaltyRate exceeds 50% cap");

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
     * @dev The oracle admin can call settleEvent() directly. The Diamond owner also
     *      retains the ability to call settleEvent() UNLESS activateOracleV2() has been
     *      called, after which ALL single-key settlement is permanently disabled and
     *      settlement must go through OracleFacet.submitRate() (multi-oracle consensus).
     *      Set to address(0) to disable the single-key oracle admin path.
     *
     * M-01 fix: previous comment wrongly stated the owner "always retains" settlement rights;
     * that is only true before activateOracleV2() is called.
     *
     * @param _admin Address that will be granted oracle admin rights. Can be address(0).
     */
    function setOracleAdmin(address _admin) external onlyOwner {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        s.hedgeOracleAdmin = _admin;
        emit OracleAdminSet(_admin);
    }

    /**
     * @notice Set or rotate the pricing-engine ECDSA signer.
     * @dev When the signer is the zero address, signature verification in createEvent()
     *      is disabled and any premium can be submitted (legacy / migration mode).
     *      When set to a non-zero address, every subsequent createEvent() MUST carry
     *      a valid ECDSA signature recoverable to this address.
     *
     *      Rotation: previously issued quotes signed by the old key become invalid
     *      immediately after this call returns. Operators should pre-warn integrators
     *      before rotating.
     *
     *      The QUOTE_MAX_AGE_SECONDS freshness window means a stolen key can be abused
     *      for at most ~2 minutes before the operator notices and rotates.
     *
     * @param _signer New pricing-engine public address. address(0) disables verification.
     */
    function setPricingEngineSigner(address _signer) external onlyOwner {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        emit PricingEngineSignerSet(s.pricingEngineSigner, _signer);
        s.pricingEngineSigner = _signer;
    }

    /**
     * @notice Returns the currently registered pricing-engine signer address.
     * @return Zero address if signature verification is disabled, else the active signer.
     */
    function getPricingEngineSigner() external view returns (address) {
        return LibAppStorage.appStorage().pricingEngineSigner;
    }

    /**
     * @notice Returns true if a quote nonce has already been consumed by createEvent().
     * @dev    Useful for off-chain callers to defensively check before submitting.
     *         The contract enforces uniqueness regardless of whether this is queried.
     */
    function isQuoteNonceUsed(bytes32 _nonce) external view returns (bool) {
        return LibAppStorage.appStorage().usedQuoteNonces[_nonce];
    }

    /**
     * @notice Permanently disable the single-key settleEvent() path and enforce
     *         multi-oracle consensus (OracleFacet) as the only settlement route.
     *
     * @dev This is a one-way flag. Once set it cannot be reversed, even by the owner.
     *      Call only after OracleFacet oracles are fully registered, tested, and confirmed
     *      operational. Calling prematurely will permanently lock manual settlement.
     *
     *      After activation:
     *        - settleEvent() in this facet reverts with "Single-key settlement disabled".
     *        - All settlement must go through OracleFacet.submitRate() → consensus path.
     */
    function activateOracleV2() external onlyOwner {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(!s.oracleV2Active, "OracleV2 already active");
        s.oracleV2Active = true;
        emit OracleV2Activated();
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
     * @notice Pause new protocol activity.
     * @dev Blocks createEvent(), deposit(), buyProtection(), and setPoolSettings().
     *      Claim and withdrawal functions (claimPayout, claimPremiums, withdrawCapital,
     *      withdrawCreatorEarnings) remain available so users can retrieve their funds
     *      during an incident — locking user funds during a pause would be harmful.
     *      Settlement via settleEvent() and oracle operations are also unaffected so that
     *      in-flight events can still be resolved.
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
        // Keep per-token counter in sync. Pre-v3 events may not have credited
        // platformFeesByToken, so floor at zero rather than allowing underflow.
        if (_amount <= s.platformFeesByToken[s.usdcToken]) {
            s.platformFeesByToken[s.usdcToken] -= _amount;
        } else {
            s.platformFeesByToken[s.usdcToken] = 0;
        }

        // C-2 fix: decrement internal reserve tracker before transferring tokens out.
        if (s.tokenReserves[s.usdcToken] >= _amount) {
            s.tokenReserves[s.usdcToken] -= _amount;
        } else {
            s.tokenReserves[s.usdcToken] = 0;
        }

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
    function recoverExpiredPayouts(uint256 _eventId) external nonReentrant {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];

        require(evt.id > 0, "Event not found");
        require(evt.status == LibAppStorage.HedgeEventStatus.Settled, "Event not settled");
        require(evt.triggered, "Event did not trigger: no payouts reserved");
        require(
            block.timestamp >= evt.settledAt + 90 days,
            "Grace period not elapsed (90 days from settlement)"
        );

        // Walk all positions and expire any that are still Claimable.
        // This prevents late-claiming hedgers from drawing funds that have already been
        // swept into platform fees, which could drain unrelated contract balances.
        uint256[] storage positionIds = s.hedgeEventPositionIds[_eventId];
        uint256 posCount = positionIds.length;
        uint256 residual = 0;
        for (uint256 i = 0; i < posCount; ++i) {
            LibAppStorage.HedgePosition storage pos = s.hedgePositions[positionIds[i]];
            if (
                pos.status == LibAppStorage.HedgePositionStatus.Claimable && !pos.claimed
            ) {
                residual += pos.payoutAmount;
                pos.payoutAmount = 0;
                pos.status = LibAppStorage.HedgePositionStatus.Expired;
            }
        }

        require(residual > 0, "No unclaimed payouts to recover");

        // Reconcile the event-level reserve.
        if (evt.totalMaxPayout >= residual) {
            evt.totalMaxPayout -= residual;
        } else {
            evt.totalMaxPayout = 0;
        }

        address eventToken = _getEventToken(s, evt);

        // C-2 fix: use internal tokenReserves instead of IERC20.balanceOf(address(this)).
        // balanceOf is manipulable by an attacker who donates tokens directly to the contract,
        // inflating the apparent balance and potentially crediting more platform fees than
        // are legitimately available. tokenReserves only reflects tokens that flowed through
        // the protocol's own accounting (safeTransferFrom / safeTransfer paths).
        uint256 actualBalance = s.tokenReserves[eventToken];
        if (residual > actualBalance) {
            residual = actualBalance;
        }
        require(residual > 0, "No recoverable payouts after balance reconciliation");

        // Sweep residual into platform fees for withdrawal by the owner.
        // Only credit the USDC-specific legacy counter for USDC events; non-USDC event
        // residuals (e.g. USDT) must be withdrawn via withdrawPlatformFeesByToken().
        if (eventToken == s.usdcToken) {
            s.hedgePlatformFeesCollected += residual;
        }
        s.platformFeesByToken[eventToken] += residual;

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
        // L-2 fix: use 10_000 gas instead of 2300. The 2300 gas stipend is insufficient
        // for a Gnosis Safe or any multisig with a receive() hook. 10_000 is large enough
        // for a Safe receive() while still bounding re-entrancy risk. The nonReentrant
        // guard provides the primary reentrancy protection.
        (bool ok, ) = _to.call{value: balance, gas: 10_000}("");
        require(ok, "ETH transfer failed");
        emit ETHRescued(_to, balance);
    }

    /**
     * @notice Sweep any ERC20 token that has been airdropped or mistakenly sent to the
     *         Diamond contract, forwarding the full balance to `_to`.
     *
     * @dev    SECURITY GUARD: rescuing the configured payment token (USDC / USDT) is
     *         explicitly blocked. All user funds (deposits, premiums, payouts) are
     *         denominated in the payment token — allowing the owner to sweep it would
     *         constitute a rug-pull. Scam / airdrop tokens use a different contract
     *         address, so this function safely removes only those.
     *
     *         The nonReentrant modifier prevents re-entrancy from malicious token contracts
     *         that implement a callback on transfer.
     *
     * @param _token ERC20 token contract address to rescue. Must not be the payment token.
     * @param _to    Recipient address. Cannot be address(0).
     */
    function rescueERC20(address _token, address _to) external onlyOwner nonReentrant {
        require(_to != address(0), "Zero address");
        require(_token != address(0), "Zero token address");

        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        // Block rescue of the primary payment token — user funds must stay in the contract.
        require(_token != s.usdcToken, "Cannot rescue payment token");
        // Also block any additional whitelisted payment tokens.
        require(!s.allowedPaymentTokens[_token], "Cannot rescue whitelisted payment token");

        IERC20 token = IERC20(_token);
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "No tokens to rescue");

        token.safeTransfer(_to, balance);
        emit ERC20Rescued(_token, _to, balance);
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
        // L007: validate token address before any storage reads.
        require(_token != address(0), "Zero address");
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(_amount > 0, "Amount must be > 0");
        require(_amount <= s.platformFeesByToken[_token], "Exceeds available fees for token");

        s.platformFeesByToken[_token] -= _amount;
        // Keep the legacy USDC aggregate counter in sync. Pre-v3 events may not have
        // credited hedgePlatformFeesCollected for this token, so floor at zero.
        if (_token == s.usdcToken) {
            if (_amount <= s.hedgePlatformFeesCollected) {
                s.hedgePlatformFeesCollected -= _amount;
            } else {
                s.hedgePlatformFeesCollected = 0;
            }
        }

        // C-2 fix: decrement internal reserve tracker before transferring tokens out.
        if (s.tokenReserves[_token] >= _amount) {
            s.tokenReserves[_token] -= _amount;
        } else {
            s.tokenReserves[_token] = 0;
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
     * @notice Parameters for creating a new hedge event (v7 range product).
     *
     * @param name            Human-readable label shown in the UI.
     * @param underlying      Currency pair identifier, e.g. "USD/GHS" or "USD/NGN".
     * @param strike          Lower edge of the payout range (the "entry" threshold).
     *                        Above the initial rate for upward hedges, below for downward.
     *                        Payouts begin once the settlement price crosses this level.
     * @param payoutCap       Far edge of the payout range (the cap). Above strike for upward
     *                        hedges, below strike for downward. Settlement prices beyond this
     *                        level produce the same maximum payout.
     *                        Set to 0 for legacy single-strike behaviour (pre-v7 events only).
     * @param premiumRate     Premium as a fraction of notional. Uses PRECISION as denominator.
     *                        E.g. 25000 = 2.5%. Maximum = PRECISION (100%).
     * @param expiryDate      Unix timestamp at which the event expires. Must be in the future
     *                        and no more than 365 days from the current block.
     * @param allowExternalLp Whether wallets other than the creator can call deposit().
     * @param initialLiquidity USDC amount for the creator's first deposit (min 10 USDC, 6 decimals).
     * @param initialRate     Current market rate at event creation time (6 decimals).
     *                        Used to calculate per-notional payouts at settlement time.
     * @param strikeAbove     Direction of the hedge.
     *                        true  = upward hedge (USD weakens). strike > initialRate, payoutCap > strike.
     *                        false = downward hedge (USD strengthens). strike < initialRate, payoutCap < strike.
     * @param paymentToken    ERC-20 stablecoin to use for all payments in this event.
     *                        Must be whitelisted via setAllowedPaymentToken(). Pass address(0)
     *                        to use the default usdcToken (always accepted, no whitelist check).
     */
    struct CreateEventParams {
        string name;
        string underlying;
        uint256 strike;
        uint256 payoutCap;
        uint256 premiumRate;
        uint256 expiryDate;
        bool allowExternalLp;
        uint256 initialLiquidity;
        uint256 initialRate;
        bool strikeAbove;
        address paymentToken;

        // ── v8: pricing-engine attestation (required when pricingEngineSigner is set) ──
        // The signature is recovered against:
        //   keccak256(abi.encode(
        //     block.chainid, address(this), msg.sender,
        //     underlying, strike, payoutCap, premiumRate, expiryDate, initialRate, strikeAbove,
        //     quoteTimestamp, quoteNonce
        //   ))
        // wrapped with the EIP-191 "Ethereum Signed Message" prefix (so the signing key can
        // use a standard wallet `personal_sign`). Pass an empty bytes signature and zero
        // values when the signer is unset (legacy mode).
        bytes signature;
        uint256 quoteTimestamp;
        bytes32 quoteNonce;
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
        // payoutCap selects the product shape:
        //   payoutCap == 0  → legacy single-strike (digital) event. Payout is the fixed
        //                     strike-vs-initialRate gap × notional, paid in full if triggered.
        //   payoutCap > 0   → v7 range (call/put-spread) event. Payout scales linearly between
        //                     strike and payoutCap, capped at the cap end.
        // Both shapes are supported simultaneously — the buyProtection() and settleEvent()
        // paths branch on evt.payoutCap to apply the correct math. Storage layout is identical
        // in both cases, so the choice is purely a creator-facing configuration.
        if (_params.strikeAbove) {
            require(
                _params.strike > _params.initialRate,
                "Strike must be above current rate for upward hedge"
            );
            if (_params.payoutCap > 0) {
                require(
                    _params.payoutCap > _params.strike,
                    "payoutCap must be above strike for upward hedge"
                );
            }
        } else {
            require(
                _params.strike < _params.initialRate,
                "Strike must be below current rate for downward hedge"
            );
            if (_params.payoutCap > 0) {
                require(
                    _params.payoutCap < _params.strike,
                    "payoutCap must be below strike for downward hedge"
                );
            }
        }
        // M-02 fix: cap the maximum per-notional payout at 10× to prevent an adversarially
        // misconfigured event from draining the pool with a single position. The thing being
        // capped depends on product shape:
        //   Range mode (payoutCap > 0)       : cap the WIDTH of the payout range (|payoutCap - strike|).
        //   Single-strike mode (payoutCap=0) : cap the strike-to-spot gap (|strike - initialRate|),
        //                                      which is the original M-02 form for digital events.
        // In both cases the result limits predeterminedPayout to ≤ 10× notional, the same
        // economic invariant — the formulas just measure "max move" differently per shape.
        {
            uint256 maxPriceMove;
            if (_params.payoutCap > 0) {
                maxPriceMove = _params.strikeAbove
                    ? _params.payoutCap - _params.strike
                    : _params.strike - _params.payoutCap;
                require(
                    maxPriceMove <= _params.initialRate * 10,
                    "Payout range too wide: max payout per notional is 10x"
                );
            } else {
                maxPriceMove = _params.strikeAbove
                    ? _params.strike - _params.initialRate
                    : _params.initialRate - _params.strike;
                require(
                    maxPriceMove <= _params.initialRate * 10,
                    "Strike too far from initial rate: max payout per notional is 10x"
                );
            }
        }

        // Resolve and validate payment token.
        // address(0) silently uses the default usdcToken; any other address must be whitelisted.
        address token = _params.paymentToken == address(0)
            ? s.usdcToken
            : _params.paymentToken;
        if (token != s.usdcToken) {
            require(s.allowedPaymentTokens[token], "Payment token not whitelisted");
        }

        // --- v8: verify pricing-engine quote signature ---
        // When s.pricingEngineSigner is unset (address(0)), legacy mode: any premium accepted.
        // When set, every event MUST carry a fresh, unique, valid signature from that signer.
        address recoveredQuoteSigner = _verifyQuoteSignature(s, _params);

        // --- Effects ---
        uint256 creationFee = s.hedgeFeeConfig.eventCreationFee;
        s.hedgePlatformFeesCollected += creationFee;
        s.platformFeesByToken[token] += creationFee;

        uint256 eventId = ++s.hedgeEventCounter;
        // totalHedgeEvents is kept in storage for layout compatibility but always equals
        // hedgeEventCounter; getTotalHedgeEvents() reads hedgeEventCounter directly.

        _initHedgeEvent(s, eventId, _params, token, recoveredQuoteSigner);

        uint256 depositId = _createInitialDeposit(s, eventId, _params.initialLiquidity);

        // --- Interactions ---
        uint256 totalAmount = creationFee + _params.initialLiquidity;
        // C-2 fix: increment internal reserve tracker when tokens flow into the Diamond.
        s.tokenReserves[token] += totalAmount;
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

    /// @dev Verify the pricing-engine quote signature in CreateEventParams.
    ///      Three modes, all returning the address that gets stored in HedgeEvent.quoteSigner:
    ///
    ///        1. Legacy mode — pricingEngineSigner is unset on the diamond.
    ///           Returns address(0). Caller may pass anything (or nothing).
    ///        2. Engine-priced mode — signer set + valid 65-byte signature.
    ///           Returns the recovered signer (== pricingEngineSigner). Hedgers can
    ///           verify on-chain that the event used the platform's pricing engine.
    ///        3. Self-priced mode — signer set + empty signature (length 0).
    ///           Returns address(0). Records "creator opted out of engine pricing"
    ///           so consumers can label the event "manually priced" in their UI.
    ///           This makes engine pricing advisory rather than mandatory.
    ///
    ///      Always reverts on a malformed signature (non-zero, non-65 bytes) — that's
    ///      almost always a bug, not an intentional override.
    ///
    ///      The signed payload deliberately includes EVERY parameter that affects the
    ///      premium math, plus chain + diamond + caller for context-binding:
    ///        - block.chainid + address(this) prevent cross-chain / cross-diamond replay
    ///        - msg.sender prevents quote-stealing (Alice can't use Bob's quote)
    ///        - underlying / strike / payoutCap / premiumRate / expiryDate / initialRate / strikeAbove
    ///          ensures the signature covers exactly the event the engine quoted
    ///        - quoteTimestamp + quoteNonce: freshness + replay protection
    function _verifyQuoteSignature(
        LibAppStorage.AppStorage storage s,
        CreateEventParams memory _params
    ) internal returns (address) {
        if (s.pricingEngineSigner == address(0)) {
            // Mode 1 — legacy. Verification disabled, signature ignored.
            return address(0);
        }

        // Mode 3 — empty signature is an explicit opt-out. The event is "self-priced"
        // and getHedgeEvent will report quoteSigner == address(0). UIs use this to
        // distinguish manually-priced events from engine-attested ones.
        if (_params.signature.length == 0) {
            return address(0);
        }

        // Mode 2 — signature provided; must be a valid 65-byte ECDSA sig and match
        // the registered pricingEngineSigner. Anything else reverts.
        require(_params.signature.length == 65, "Quote signature wrong length");
        require(_params.quoteTimestamp > 0, "Quote timestamp required");
        require(_params.quoteNonce != bytes32(0), "Quote nonce required");
        require(
            block.timestamp <= _params.quoteTimestamp + QUOTE_MAX_AGE_SECONDS,
            "Quote expired (signed > 120s ago)"
        );
        require(
            _params.quoteTimestamp <= block.timestamp,
            "Quote timestamp in future"
        );
        require(!s.usedQuoteNonces[_params.quoteNonce], "Quote nonce already used");

        bytes32 messageHash = keccak256(abi.encode(
            block.chainid,
            address(this),
            msg.sender,
            _params.underlying,
            _params.strike,
            _params.payoutCap,
            _params.premiumRate,
            _params.expiryDate,
            _params.initialRate,
            _params.strikeAbove,
            _params.quoteTimestamp,
            _params.quoteNonce
        ));
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(messageHash);

        address recovered = ECDSA.recover(ethSignedHash, _params.signature);
        require(recovered == s.pricingEngineSigner, "Invalid pricing-engine signature");

        // Mark consumed BEFORE returning so a re-entrant call inside the same tx
        // (shouldn't be possible, but defence-in-depth) cannot reuse it.
        s.usedQuoteNonces[_params.quoteNonce] = true;
        return recovered;
    }

    /// @dev Initialises the HedgeEvent storage struct and registers the creator's event ID.
    ///      `_resolvedToken` is the final payment token address already validated by createEvent().
    ///      `_quoteSigner` is the recovered pricing-engine signer (or address(0) in legacy mode).
    function _initHedgeEvent(
        LibAppStorage.AppStorage storage s,
        uint256 eventId,
        CreateEventParams memory _params,
        address _resolvedToken,
        address _quoteSigner
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
        evt.payoutCap = _params.payoutCap;
        evt.quoteSigner = _quoteSigner;
        evt.createdAt = block.timestamp;
        // Store the resolved token. For USDC events this is s.usdcToken; zero address is
        // never stored here — the resolution already happened in createEvent().
        evt.paymentToken = _resolvedToken;

        // Fix 1 — Snapshot current fee rates onto this event so future changes to the global
        // config cannot retroactively affect hedgers, LPs, or the creator who have already
        // committed capital.
        evt.snapshotHedgerFeeRate    = s.hedgeFeeConfig.hedgerFeeRate;
        evt.snapshotPayoutFeeRate    = s.hedgeFeeConfig.hedgerPayoutFeeRate;
        evt.snapshotLpProfitFeeRate  = s.hedgeFeeConfig.lpProfitFeeRate;
        evt.snapshotCreatorLoyaltyRate = s.hedgeFeeConfig.creatorLoyaltyRate;
        evt.feeSnapshotSet = true;

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
     * @dev Returns the fee rates applicable to an event.
     *      v5+ events have rates snapshotted at creation (feeSnapshotSet = true).
     *      Pre-v5 events fall back to the current global config for backward compatibility.
     *
     * @return hedgerFeeRate      Platform fee on notional at buyProtection().
     * @return payoutFeeRate      Platform fee on gross payout at claimPayout().
     * @return lpProfitFeeRate    Platform fee on premium claim at claimPremiums().
     * @return creatorLoyaltyRate Share of every platform fee credited to the event creator.
     */
    function _eventFees(
        LibAppStorage.HedgeEvent storage evt,
        LibAppStorage.AppStorage storage s
    ) internal view returns (
        uint256 hedgerFeeRate,
        uint256 payoutFeeRate,
        uint256 lpProfitFeeRate,
        uint256 creatorLoyaltyRate
    ) {
        if (evt.feeSnapshotSet) {
            return (
                evt.snapshotHedgerFeeRate,
                evt.snapshotPayoutFeeRate,
                evt.snapshotLpProfitFeeRate,
                evt.snapshotCreatorLoyaltyRate
            );
        }
        return (
            s.hedgeFeeConfig.hedgerFeeRate,
            s.hedgeFeeConfig.hedgerPayoutFeeRate,
            s.hedgeFeeConfig.lpProfitFeeRate,
            s.hedgeFeeConfig.creatorLoyaltyRate
        );
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
        uint256 shares = amount * SHARES_PRECISION / PRECISION;
        dep.shares = shares;
        dep.createdAt = block.timestamp;
        // Fix 4 (MasterChef): accPremiumPerShare = 0 at creation, so rewardDebt = 0.
        // Explicitly stored for clarity; zero-init is the Solidity default.
        dep.rewardDebt = 0;
        // Maintain running total so deposit() and _distributePremiumToLps() are O(1).
        s.hedgeEvents[eventId].totalActiveShares += shares;
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
    ) external nonReentrant whenNotPaused {
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
     *      Deposits are capped at MAX_DEPOSITS_PER_EVENT (200).
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
        // Fix 2 — creator can always deposit (to seed liquidity before pool opens).
        // External LPs require both poolOpen AND allowExternalLp so the creator's
        // explicit pool-closed intent is enforced.
        require(isCreator || (evt.poolOpen && evt.allowExternalLp), "Pool closed to external LPs");

        // --- Effects ---
        // Fix 4 (MasterChef): use evt.totalActiveShares maintained in O(1) rather than
        // the old _getTotalShares() O(n) loop.
        uint256 shares;
        if (evt.totalLiquidity == 0) {
            shares = _amount * SHARES_PRECISION / PRECISION;
        } else {
            shares = (_amount * evt.totalActiveShares) / evt.totalLiquidity;
        }
        // M-03 fix: guard against donation/inflation attacks where the pool is so large
        // relative to _amount that integer division produces zero shares.
        // A deposit that receives zero shares would contribute liquidity to the pool
        // without receiving any claim on premiums or capital, effectively donating to LPs.
        require(shares > 0, "Deposit too small relative to pool size: would receive zero shares");

        evt.totalLiquidity += _amount;
        evt.lpCount++;
        evt.totalActiveShares += shares;

        uint256 depositId = ++s.hedgeLpDepositCounter;
        LibAppStorage.HedgeLpDeposit storage dep = s.hedgeLpDeposits[depositId];
        dep.id = depositId;
        dep.eventId = _eventId;
        dep.lp = msg.sender;
        dep.amount = _amount;
        dep.shares = shares;
        dep.createdAt = block.timestamp;
        // Fix 4 (MasterChef): set rewardDebt to the current accumulator value so this
        // LP cannot claim premiums that were distributed before they joined.
        dep.rewardDebt = (shares * evt.accPremiumPerShare) / ACC_PREMIUM_MULTIPLIER;

        s.hedgeEventDepositIds[_eventId].push(depositId);
        s.lpDepositIds[msg.sender].push(depositId);

        // --- Interactions ---
        address depositToken = _getEventToken(s, evt);
        // C-2 fix: increment internal reserve tracker when tokens flow into the Diamond.
        s.tokenReserves[depositToken] += _amount;
        IERC20(depositToken).safeTransferFrom(msg.sender, address(this), _amount);

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
     * @param _maxCost  M-3 fix: maximum acceptable total cost (premium + platform fee).
     *                  Reverts if actual cost exceeds this value. Pass type(uint256).max to skip.
     * @param _deadline M-3 fix: Unix timestamp after which this transaction must not execute.
     *                  Pass type(uint256).max to skip.
     * @return positionId The ID of the newly created hedge position.
     */
    function buyProtection(uint256 _eventId, uint256 _notional, uint256 _maxCost, uint256 _deadline)
        external
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];

        // --- Checks ---
        require(block.timestamp <= _deadline, "Transaction deadline expired");
        require(evt.id > 0, "Event not found");
        require(evt.status == LibAppStorage.HedgeEventStatus.Open, "Event not open");
        require(evt.poolOpen, "Pool not open for hedging");
        require(block.timestamp < evt.expiryDate, "Event expired");
        require(_notional >= 10 * PRECISION, "Min notional: 10 USDC");
        require(
            s.hedgeEventPositionIds[_eventId].length < MAX_POSITIONS_PER_EVENT,
            "Max positions reached for this event"
        );

        // v7 range product: reserve the WORST-CASE payout (settlement reaching the cap)
        // for solvency. The actual payout is computed at settlement based on where the
        // settlement price lands within the range; it can be anywhere in [0, predetermined].
        // Pre-v7 (legacy single-strike) events have payoutCap == 0 and fall back to the
        // original strike-vs-initialRate gap. No live events exist at this gap so the
        // legacy branch is dead code, but kept for any historical replay scenarios.
        uint256 maxPriceMove;
        if (evt.payoutCap == 0) {
            // Legacy single-strike (pre-v7).
            maxPriceMove = evt.strikeAbove
                ? evt.strike - evt.initialRate
                : evt.initialRate - evt.strike;
        } else {
            // v7 range product — width of the payout zone.
            maxPriceMove = evt.strikeAbove
                ? evt.payoutCap - evt.strike
                : evt.strike - evt.payoutCap;
        }
        uint256 predeterminedPayout = (_notional * maxPriceMove) / evt.initialRate;

        uint256 availableLiquidity = evt.totalLiquidity - evt.totalMaxPayout;
        require(predeterminedPayout <= availableLiquidity, "Insufficient pool liquidity for payout");

        // Fix 1 — use fee rates snapshotted at event creation, not the current global config.
        (uint256 hedgerFeeRate, , , uint256 creatorLoyaltyRate) = _eventFees(evt, s);

        uint256 premium = (_notional * evt.premiumRate) / PRECISION;
        uint256 platformFee = (_notional * hedgerFeeRate) / PRECISION;
        uint256 totalCost = premium + platformFee;

        // M-3 fix: slippage guard — revert if actual cost exceeds caller's stated maximum.
        require(totalCost <= _maxCost, "Cost exceeds slippage limit");

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

        uint256 creatorReward = (platformFee * creatorLoyaltyRate) / PRECISION;
        evt.creatorEarnings += creatorReward;
        uint256 netPlatformFee = platformFee - creatorReward;
        s.hedgePlatformFeesCollected += netPlatformFee;

        address token = _getEventToken(s, evt);
        s.platformFeesByToken[token] += netPlatformFee;

        // --- Interactions ---
        // C-2 fix: increment internal reserve tracker when tokens flow into the Diamond.
        s.tokenReserves[token] += totalCost;
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
    // H-3: nonReentrant added for defence-in-depth even though settleEvent has no
    // token transfers. Prevents cross-function reentrancy via the shared AppStorage lock.
    function settleEvent(uint256 _eventId, uint256 _settlementPrice) external onlyOracleAdmin nonReentrant {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];

        require(evt.id > 0, "Event not found");
        require(evt.status == LibAppStorage.HedgeEventStatus.Open, "Already settled");
        require(_settlementPrice > 0, "Invalid price");
        // H-1 fix: oracleV2Active guard is now enforced in the onlyOracleAdmin modifier
        // (single point of enforcement). The duplicate check here has been removed.

        // Fix 3 — Fallback oracle guard: prevent settling an event that nobody has joined.
        // An event with zero hedger positions has nothing to resolve and settling it early
        // would allow front-running the pool (settle before any user can participate).
        // After expiry the event can always be closed regardless of participation.
        require(
            evt.hedgerCount > 0 || block.timestamp >= evt.expiryDate,
            "Cannot settle: no hedger positions and event has not expired"
        );

        // European-style settlement: an event may ONLY be settled at or after its expiry
        // date — even if the strike has already been touched. This guarantees that payouts
        // are never released early. The strike/trigger condition is evaluated using the
        // settlement price posted at (or after) expiry.
        //
        // NOTE: this replaces the previous "settle early once the strike is touched" rule
        // (the old M-1 guard). A strike that is touched mid-period but has retraced past the
        // strike by expiry will NOT pay out, because `triggered` is judged from the price
        // submitted at settlement time (i.e. at/after expiry).
        bool alreadyTriggered = evt.strikeAbove
            ? _settlementPrice >= evt.strike
            : _settlementPrice <= evt.strike;
        require(
            block.timestamp >= evt.expiryDate,
            "Too early: settlement only allowed at or after expiry"
        );

        // L-3 fix: reject settlement prices that are wildly implausible to catch
        // obvious oracle errors (e.g. off-by-one-million-X typos). A price is accepted
        // only if it falls within [initialRate / 100, initialRate * 100], i.e. within
        // two orders of magnitude of the rate recorded at event creation. Real FX
        // rates do not move 100× in any reasonable time horizon.
        require(
            _settlementPrice >= evt.initialRate / 100 && _settlementPrice <= evt.initialRate * 100,
            "Settlement price out of plausible range (must be within 100x of initial rate)"
        );

        bool triggered = alreadyTriggered;

        evt.status = LibAppStorage.HedgeEventStatus.Settled;
        evt.settlementPrice = _settlementPrice;
        evt.triggered = triggered;
        evt.settledAt = block.timestamp;

        // C-1 fix: snapshot totalLiquidity at the moment of settlement. withdrawCapital()
        // uses this value as the denominator when computing each LP's payout share.
        // Without the snapshot, the denominator shrinks as LPs withdraw, causing each
        // subsequent LP to be charged an increasing fraction of the remaining payouts.
        evt.liquidityAtSettlement = evt.totalLiquidity;

        // v7 range product: compute the per-notional payout factor ONCE here, using the
        // event-level strike, payoutCap, and settlement price. Each position then scales
        // it by its own notional. This collapses the per-position computation to a single
        // multiplication inside the loop, keeping settlement gas cost essentially the same
        // as the legacy single-strike version.
        //
        // Geometry (when triggered):
        //   upward   : effective = min(settlement, payoutCap), move = effective - strike
        //   downward : effective = max(settlement, payoutCap), move = strike - effective
        //
        // Pre-v7 events (payoutCap == 0) fall back to the original digital behaviour:
        // every triggered position gets its full reserved payoutAmount.
        uint256 effectivePriceMove = 0;
        if (triggered && evt.payoutCap != 0) {
            uint256 effectiveRate;
            if (evt.strikeAbove) {
                effectiveRate = _settlementPrice >= evt.payoutCap ? evt.payoutCap : _settlementPrice;
                effectivePriceMove = effectiveRate - evt.strike;
            } else {
                effectiveRate = _settlementPrice <= evt.payoutCap ? evt.payoutCap : _settlementPrice;
                effectivePriceMove = evt.strike - effectiveRate;
            }
        }

        uint256[] storage positionIds = s.hedgeEventPositionIds[_eventId];
        // G001: cache array length to avoid repeated storage reads in the loop.
        uint256 positionCount = positionIds.length;
        // v7: track the actual aggregate payout so we can refresh totalMaxPayout to the
        // realised reservation. LPs withdrawing later then absorb the actual loss, not the
        // worst-case reservation that was sized at buy time.
        uint256 totalActualPayout = 0;
        for (uint256 i = 0; i < positionCount; ++i) {  // G011: pre-increment
            LibAppStorage.HedgePosition storage pos = s.hedgePositions[positionIds[i]];
            if (pos.status != LibAppStorage.HedgePositionStatus.Active) continue;

            if (!triggered) {
                pos.payoutAmount = 0;
                pos.status = LibAppStorage.HedgePositionStatus.Expired;
                continue;
            }

            // Triggered branch.
            uint256 actualPayout;
            if (evt.payoutCap == 0) {
                // Legacy single-strike: reserved payout was the actual payout.
                actualPayout = pos.payoutAmount;
            } else {
                // v7 range: scale per-notional move by this position's notional.
                actualPayout = (pos.notional * effectivePriceMove) / evt.initialRate;
            }

            pos.payoutAmount = actualPayout;
            if (actualPayout > 0) {
                pos.status = LibAppStorage.HedgePositionStatus.Claimable;
                totalActualPayout += actualPayout;
            } else {
                // Edge case: triggered exactly at strike, zero range move => zero payout.
                pos.status = LibAppStorage.HedgePositionStatus.Expired;
            }
        }

        // v7: refresh totalMaxPayout to the realised aggregate so withdrawCapital()
        // computes LP loss share against actual payouts, not the buy-time reservation.
        evt.totalMaxPayout = totalActualPayout;

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

        // Fix 1 — load the event first so we can use its snapshotted fee rates.
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[pos.eventId];
        (, uint256 payoutFeeRate, , uint256 creatorLoyaltyRate) = _eventFees(evt, s);

        uint256 grossPayout = pos.payoutAmount;
        uint256 payoutFee = (grossPayout * payoutFeeRate) / PRECISION;
        uint256 netPayout = grossPayout - payoutFee;
        // L003: guard against a zero-value transfer (possible only if hedgerPayoutFeeRate = 100%).
        require(netPayout > 0, "Net payout rounds to zero");

        uint256 creatorReward = (payoutFee * creatorLoyaltyRate) / PRECISION;
        evt.creatorEarnings += creatorReward;
        uint256 netPayoutFee = payoutFee - creatorReward;
        s.hedgePlatformFeesCollected += netPayoutFee;

        address token = _getEventToken(s, evt);
        s.platformFeesByToken[token] += netPayoutFee;

        // Track total tokens actually paid out for this event.
        evt.totalPayoutClaimed += grossPayout;

        // v7 fix: do NOT decrement totalMaxPayout here. The previous decrement created a
        // path-dependence bug:
        //
        //   if hedger claimed BEFORE LP withdrew, totalMaxPayout dropped to 0 and the LP
        //   withdraw branch `if (triggered && totalMaxPayout > 0)` skipped the loss-share
        //   deduction → LP received their full deposit back even though the pool had
        //   already paid out to the hedger → underflow / insolvency.
        //
        // The withdrawCapital() comment was always correct: the LP loss share denominator
        // should be the FULL aggregate payout obligation set at settlement, regardless of
        // which hedgers have already claimed. Path-independence: LP-first or hedger-first
        // produces identical pool conservation. Unclaimed reservations after the 90-day
        // grace period are swept to platform fees by recoverExpiredPayouts(), which uses
        // its own per-position residual computation and does not depend on this counter
        // staying current.
        //
        // totalPayoutClaimed (just incremented above) is the running record of how much
        // has actually flowed out — use that field for any "how much paid so far" reads.

        pos.claimed = true;
        pos.status = LibAppStorage.HedgePositionStatus.Claimed;

        // C-2 fix: decrement internal reserve tracker before transferring tokens out.
        if (s.tokenReserves[token] >= netPayout) {
            s.tokenReserves[token] -= netPayout;
        } else {
            s.tokenReserves[token] = 0;
        }

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
        // H-01 fix: block premium claims after capital has been withdrawn.
        // dep.shares is not zeroed on withdrawal, so without this check an LP
        // could claim premiums indefinitely after calling withdrawCapital().
        require(!dep.withdrawn, "Capital already withdrawn: cannot claim premiums");

        // Fix 4 (MasterChef): compute claimable using the accumulator rather than the
        // push-distributed premiumsEarned field.  rewardDebt records the value of
        // (shares * accPremiumPerShare) the last time this LP claimed or deposited.
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[dep.eventId];
        uint256 accured = (dep.shares * evt.accPremiumPerShare) / ACC_PREMIUM_MULTIPLIER;
        uint256 claimable = accured - dep.rewardDebt;
        require(claimable > 0, "No premiums to claim");

        // Fix 1 — use fee rates snapshotted at event creation.
        (, , uint256 lpProfitFeeRate, uint256 creatorLoyaltyRate) = _eventFees(evt, s);

        uint256 lpFee = (claimable * lpProfitFeeRate) / PRECISION;
        uint256 netAmount = claimable - lpFee;
        // L003: guard against zero-value transfer (possible only if lpProfitFeeRate = 100%).
        require(netAmount > 0, "Net premium amount rounds to zero");

        uint256 creatorReward = (lpFee * creatorLoyaltyRate) / PRECISION;
        evt.creatorEarnings += creatorReward;
        uint256 netLpFee = lpFee - creatorReward;
        s.hedgePlatformFeesCollected += netLpFee;

        address token = _getEventToken(s, evt);
        s.platformFeesByToken[token] += netLpFee;

        // M-5 fix: verify the contract holds sufficient tokens before transferring.
        // This guards against an edge case where accounting fields (accPremiumPerShare,
        // platformFeesByToken) could theoretically overstate claimable amounts relative
        // to the actual on-chain balance (e.g. if a separate facet bug drained tokens).
        require(s.tokenReserves[token] >= netAmount, "Insufficient contract balance for premium");

        // Update rewardDebt and tracking fields before the transfer (CEI).
        dep.rewardDebt = accured;
        dep.premiumsEarned += claimable;
        dep.premiumsClaimed += claimable;

        // C-2 fix: decrement internal reserve tracker before transferring tokens out.
        s.tokenReserves[token] -= netAmount;

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
     *      totalMaxPayout (the full sum of all predetermined payouts, including those still
     *      reserved for winning hedgers who have not yet called claimPayout()).
     *      Using totalMaxPayout rather than totalPayoutClaimed keeps the contract solvent
     *      for all remaining claimants — withdrawing unclaimed payout shares would leave
     *      the contract unable to pay winning hedgers.  Any reserved-but-unclaimed payouts
     *      after the 90-day grace period are swept into platform fees via recoverExpiredPayouts().
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

        // Fix 4 (MasterChef): keep totalActiveShares accurate so future premium distributions
        // do not credit shares belonging to withdrawn deposits.
        if (evt.totalActiveShares >= dep.shares) {
            evt.totalActiveShares -= dep.shares;
        } else {
            evt.totalActiveShares = 0; // underflow guard; should not occur in normal operation
        }

        uint256 withdrawAmount = dep.amount;

        if (evt.triggered && evt.totalMaxPayout > 0) {
            // C-1 fix: use liquidityAtSettlement (snapshotted at settlement time) instead of
            // the live totalLiquidity. After settlement, totalLiquidity is unchanged but each
            // LP withdrawal does not alter it. Using the snapshot ensures every LP's payout
            // share is computed against the same pool size, regardless of withdrawal order.
            // For pre-fix events where liquidityAtSettlement was not recorded (= 0), fall back
            // to totalLiquidity to preserve backward compatibility.
            uint256 refLiquidity = evt.liquidityAtSettlement > 0
                ? evt.liquidityAtSettlement
                : evt.totalLiquidity;

            if (refLiquidity > 0) {
                // Single-step calculation avoids compounding truncation from two divisions.
                uint256 lpPayoutShare = (evt.totalMaxPayout * dep.amount) / refLiquidity;
                if (lpPayoutShare > withdrawAmount) {
                    withdrawAmount = 0;
                } else {
                    withdrawAmount -= lpPayoutShare;
                }
            }
        }

        address withdrawToken = _getEventToken(s, evt);

        if (withdrawAmount > 0) {
            // C-2 fix: decrement internal reserve tracker before transferring tokens out.
            if (s.tokenReserves[withdrawToken] >= withdrawAmount) {
                s.tokenReserves[withdrawToken] -= withdrawAmount;
            } else {
                s.tokenReserves[withdrawToken] = 0;
            }
            IERC20(withdrawToken).safeTransfer(msg.sender, withdrawAmount);
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

        address creatorToken = _getEventToken(s, evt);

        // C-2 fix: decrement internal reserve tracker before transferring tokens out.
        if (s.tokenReserves[creatorToken] >= amount) {
            s.tokenReserves[creatorToken] -= amount;
        } else {
            s.tokenReserves[creatorToken] = 0;
        }

        IERC20(creatorToken).safeTransfer(msg.sender, amount);

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
     * @notice Get the v7 range geometry of a hedge event.
     * @dev    Returns 0 for `payoutCap` on legacy single-strike events. Frontends should
     *         treat `payoutCap == 0` as "this event is a digital, render single-strike UI".
     * @param _eventId The event ID to query.
     * @return strike       Lower edge of the payout zone (entry threshold).
     * @return payoutCap    Far edge of the payout zone (cap). Zero on legacy events.
     * @return initialRate  Spot rate at event creation (6 decimals).
     * @return strikeAbove  true = upward hedge; false = downward hedge.
     */
    function getHedgeEventRange(uint256 _eventId)
        external
        view
        returns (uint256 strike, uint256 payoutCap, uint256 initialRate, bool strikeAbove)
    {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];
        return (evt.strike, evt.payoutCap, evt.initialRate, evt.strikeAbove);
    }

    /**
     * @notice Returns the pricing-engine signer that authorised this event's premium.
     * @dev    Zero address means the event was created in legacy mode (no signer set
     *         globally at the time of createEvent). A non-zero value means the event
     *         premium was cryptographically attested by that signer.
     *
     *         Frontends should display a "Fair-Priced ✓" badge when this is non-zero
     *         AND equals the current global pricingEngineSigner.
     */
    function getEventQuoteSigner(uint256 _eventId) external view returns (address) {
        return LibAppStorage.appStorage().hedgeEvents[_eventId].quoteSigner;
    }

    /**
     * @notice Quote the actual payout a position WOULD receive at a given hypothetical
     *         settlement price, without modifying state. Useful for frontend "what-if"
     *         displays and underwriter risk dashboards.
     *
     *         Mirrors the math in settleEvent() exactly. Returns 0 for not-triggered prices.
     *
     * @param _eventId        The event to quote against.
     * @param _hypoSettlement A hypothetical settlement price (6 decimals).
     * @param _notional       Notional amount to quote (6 decimals).
     * @return payout         Computed payout in payment-token units (6 decimals).
     */
    function quoteRangePayout(uint256 _eventId, uint256 _hypoSettlement, uint256 _notional)
        external
        view
        returns (uint256 payout)
    {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];
        if (evt.id == 0 || _hypoSettlement == 0 || _notional == 0) return 0;

        bool triggered = evt.strikeAbove
            ? _hypoSettlement >= evt.strike
            : _hypoSettlement <= evt.strike;
        if (!triggered) return 0;

        uint256 priceMove;
        if (evt.payoutCap == 0) {
            // Legacy single-strike: full predetermined gap.
            priceMove = evt.strikeAbove
                ? evt.strike - evt.initialRate
                : evt.initialRate - evt.strike;
        } else if (evt.strikeAbove) {
            uint256 effective = _hypoSettlement >= evt.payoutCap ? evt.payoutCap : _hypoSettlement;
            priceMove = effective - evt.strike;
        } else {
            uint256 effective = _hypoSettlement <= evt.payoutCap ? evt.payoutCap : _hypoSettlement;
            priceMove = evt.strike - effective;
        }
        return (_notional * priceMove) / evt.initialRate;
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
        // hedgeEventCounter == totalHedgeEvents at all times; reading the single source.
        return LibAppStorage.appStorage().hedgeEventCounter;
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
     * @dev Fix 4 — MasterChef-style O(1) premium accumulator.
     *
     *      Previous implementation iterated all LP deposits on every buyProtection() call
     *      (up to 200 iterations, ~3-5M gas at scale).  This replacement updates a single
     *      per-event accumulator in constant time; LPs pull their share lazily at
     *      claimPremiums() time using the (shares × accPremiumPerShare − rewardDebt) formula.
     *
     *      totalActiveShares is maintained by deposit() (+shares) and withdrawCapital() (−shares),
     *      so no loop is needed here either.
     *
     * @param s        Reference to AppStorage.
     * @param _eventId The event to distribute premiums for.
     * @param _premium Total premium to distribute across all active LP deposits (USDC, 6 dec).
     */
    function _distributePremiumToLps(
        LibAppStorage.AppStorage storage s,
        uint256 _eventId,
        uint256 _premium
    ) internal {
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];
        if (evt.totalActiveShares == 0) return;

        // H-2 fix: track integer remainder (dust) from the per-share accumulator.
        // Each call computes accPremiumPerShare += (premium * ACC_MULTIPLIER) / totalActiveShares.
        // The division discards a remainder of up to (totalActiveShares - 1) units, which is
        // silently lost under the original implementation. Over many buyProtection() calls
        // this dust can become material. We accumulate it in evt.premiumDust and distribute
        // a bonus increment whenever the accumulated dust is >= totalActiveShares (i.e. enough
        // to add at least 1 unit per share when divided through).
        uint256 scaledPremium = _premium * ACC_PREMIUM_MULTIPLIER;
        uint256 increment = scaledPremium / evt.totalActiveShares;
        uint256 remainder = scaledPremium % evt.totalActiveShares;

        // Accumulate remainder; roll over any full increment's worth of dust.
        evt.premiumDust += remainder;
        if (evt.premiumDust >= evt.totalActiveShares) {
            uint256 bonusIncrements = evt.premiumDust / evt.totalActiveShares;
            increment += bonusIncrements;
            evt.premiumDust = evt.premiumDust % evt.totalActiveShares;
        }

        evt.accPremiumPerShare += increment;
    }

    /**
     * @notice Return the gross premiums pending (before fees) for an LP deposit.
     * @dev Equivalent to the amount claimPremiums() would compute before deducting lpProfitFeeRate.
     *      Returns 0 if the deposit has been withdrawn.
     *
     * @param _depositId The LP deposit to query.
     * @return pending   Gross USDC premiums available to claim (6 decimals).
     */
    function pendingPremiums(uint256 _depositId) external view returns (uint256 pending) {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeLpDeposit storage dep = s.hedgeLpDeposits[_depositId];
        if (dep.id == 0 || dep.withdrawn) return 0;
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[dep.eventId];
        uint256 accured = (dep.shares * evt.accPremiumPerShare) / ACC_PREMIUM_MULTIPLIER;
        pending = accured > dep.rewardDebt ? accured - dep.rewardDebt : 0;
    }
}
