// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibAppStorage} from "../libraries/LibAppStorage.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

/**
 * @title BlockFinaXHedgeFacet
 * @notice On-chain P2P Hedge — FX protection marketplace
 *
 * Lifecycle:
 *   1. Creator calls createEvent() — pays creation fee, deposits initial liquidity
 *   2. Creator calls setPoolOpen(true) — opens pool for hedgers
 *   3. LPs call deposit() — add USDC, receive proportional shares
 *   4. Hedgers call buyProtection() — pay premium (→ LPs) + platform fee
 *   5. Oracle admin calls settleEvent() — posts FX rate, resolves all positions
 *   6. Hedgers call claimPayout() — collect winnings (minus 1% fee)
 *   7. LPs call claimPremiums() — collect earned premiums (minus 1% fee)
 *   8. LPs call withdrawCapital() — retrieve deposited USDC after settlement
 *
 * Fee structure:
 *   - Event creation: 25 USDC flat fee
 *   - Hedger fee: 0.5% of notional (on top of premium)
 *   - Hedger payout fee: 1% of gross payout (deducted at claim)
 *   - LP profit fee: 1% of premium claim (deducted at claim)
 *   - Creator loyalty: 5% of every platform fee → event creator
 *
 * Security:
 *   - nonReentrant on all state-changing user functions
 *   - CEI (Check-Effects-Interactions) ordering throughout
 *   - Emergency pause via pause()/unpause()
 *   - Two-step ownership transfer (propose + accept)
 *   - Bounded loops: MAX_POSITIONS_PER_EVENT = 500, MAX_DEPOSITS_PER_EVENT = 200
 *   - Fee initialization guard — createEvent() reverts until initializeHedgeFees() called
 *   - Max expiry 365 days, max premiumRate 100% (PRECISION)
 *
 * All USDC is held by the Diamond contract. No external treasury wallet needed.
 */
contract BlockFinaXHedgeFacet {
    using SafeERC20 for IERC20;

    uint256 constant PRECISION = 1e6;
    uint256 constant SHARES_PRECISION = 1e18;

    /// @dev Maximum hedger positions per event — caps settleEvent() loop gas cost
    uint256 constant MAX_POSITIONS_PER_EVENT = 500;

    /// @dev Maximum LP deposits per event — caps _distributePremiumToLps() loop gas cost
    uint256 constant MAX_DEPOSITS_PER_EVENT = 200;

    // ============================================================
    //                          EVENTS
    // ============================================================

    event HedgeEventCreated(
        uint256 indexed eventId,
        address indexed creator,
        string underlying,
        uint256 strike,
        uint256 premiumRate,
        uint256 expiryDate,
        uint256 initialLiquidity
    );

    event PoolSettingsUpdated(
        uint256 indexed eventId,
        bool poolOpen,
        bool allowExternalLp
    );

    event LiquidityDeposited(
        uint256 indexed eventId,
        uint256 indexed depositId,
        address indexed lp,
        uint256 amount,
        uint256 shares
    );

    event ProtectionPurchased(
        uint256 indexed eventId,
        uint256 indexed positionId,
        address indexed hedger,
        uint256 notional,
        uint256 premiumPaid,
        uint256 platformFee,
        uint256 totalCost
    );

    event EventSettled(
        uint256 indexed eventId,
        uint256 settlementPrice,
        bool triggered
    );

    event PayoutClaimed(
        uint256 indexed positionId,
        address indexed hedger,
        uint256 grossPayout,
        uint256 fee,
        uint256 netPayout
    );

    event PremiumsClaimed(
        uint256 indexed depositId,
        address indexed lp,
        uint256 grossAmount,
        uint256 fee,
        uint256 netAmount
    );

    event CapitalWithdrawn(
        uint256 indexed depositId,
        address indexed lp,
        uint256 amount
    );

    event CreatorEarningsWithdrawn(
        uint256 indexed eventId,
        address indexed creator,
        uint256 amount
    );

    event PlatformFeesWithdrawn(
        address indexed admin,
        uint256 amount
    );

    event FeesInitialized(
        uint256 eventCreationFee,
        uint256 hedgerFeeRate,
        uint256 hedgerPayoutFeeRate,
        uint256 lpProfitFeeRate,
        uint256 creatorLoyaltyRate
    );

    event OracleAdminSet(address indexed admin);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event ETHRescued(address indexed to, uint256 amount);

    // ============================================================
    //                       MODIFIERS
    // ============================================================

    modifier onlyOwner() {
        require(msg.sender == LibDiamond.contractOwner(), "Not owner");
        _;
    }

    modifier onlyOracleAdmin() {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(
            msg.sender == s.hedgeOracleAdmin || msg.sender == LibDiamond.contractOwner(),
            "Not oracle admin"
        );
        _;
    }

    /// @dev Diamond-compatible reentrancy guard using AppStorage slot
    modifier nonReentrant() {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(!s.hedgeReentrancyLock, "Reentrant call");
        s.hedgeReentrancyLock = true;
        _;
        s.hedgeReentrancyLock = false;
    }

    /// @dev Emergency circuit breaker — blocks all user-facing state changes
    modifier whenNotPaused() {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(!s.paused, "Protocol is paused");
        _;
    }

    // ============================================================
    //                    ADMIN FUNCTIONS
    // ============================================================

    /**
     * @notice Initialize hedge fee configuration (must be called before createEvent())
     * @dev Calling again overwrites the previous config — owner only.
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
     * @notice Set oracle admin address (can post settlement prices via single-key path)
     */
    function setOracleAdmin(address _admin) external onlyOwner {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        s.hedgeOracleAdmin = _admin;
        emit OracleAdminSet(_admin);
    }

    /**
     * @notice Propose a new owner. The new owner must call acceptOwnership() to confirm.
     * @dev Two-step transfer prevents accidentally locking out the owner.
     */
    function transferOwnership(address _newOwner) external onlyOwner {
        LibDiamond.transferOwnership(_newOwner);
    }

    /**
     * @notice Accept ownership — must be called by the pending owner.
     */
    function acceptOwnership() external {
        LibDiamond.acceptOwnership();
    }

    /**
     * @notice Return the address of the proposed new owner (pending confirmation).
     */
    function pendingOwner() external view returns (address) {
        return LibDiamond.pendingOwner();
    }

    /**
     * @notice Pause all user-facing state-changing functions.
     * @dev Use in emergencies. Oracle admin can still settle events while paused.
     */
    function pause() external onlyOwner {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(!s.paused, "Already paused");
        s.paused = true;
        emit Paused(msg.sender);
    }

    /**
     * @notice Unpause the protocol.
     */
    function unpause() external onlyOwner {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(s.paused, "Not paused");
        s.paused = false;
        emit Unpaused(msg.sender);
    }

    /**
     * @notice Withdraw accumulated platform fees
     */
    function withdrawPlatformFees(uint256 _amount) external onlyOwner nonReentrant {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(_amount <= s.hedgePlatformFeesCollected, "Exceeds collected fees");

        s.hedgePlatformFeesCollected -= _amount;
        IERC20(s.usdcToken).safeTransfer(msg.sender, _amount);

        emit PlatformFeesWithdrawn(msg.sender, _amount);
    }

    /**
     * @notice Rescue any ETH accidentally sent to the Diamond.
     * @dev ETH has no legitimate use in this contract (USDC only).
     */
    function rescueETH(address payable _to) external onlyOwner {
        require(_to != address(0), "Zero address");
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH to rescue");
        (bool ok, ) = _to.call{value: balance}("");
        require(ok, "ETH transfer failed");
        emit ETHRescued(_to, balance);
    }

    // ============================================================
    //                    VIEW: PROTOCOL STATE
    // ============================================================

    function isPaused() external view returns (bool) {
        return LibAppStorage.appStorage().paused;
    }

    function isFeesInitialized() external view returns (bool) {
        return LibAppStorage.appStorage().feesInitialized;
    }

    // ============================================================
    //                    CREATE EVENT
    // ============================================================

    /**
     * @notice Create a new hedge event with initial liquidity
     * @param _name Human-readable name
     * @param _underlying Currency pair, e.g. "USD/GHS"
     * @param _strike Trigger price (6 decimals)
     * @param _premiumRate Premium as fraction of notional (6 decimals, max = PRECISION = 100%)
     * @param _expiryDate Unix timestamp when event expires (max 365 days from now)
     * @param _allowExternalLp Whether non-creators can deposit
     * @param _initialLiquidity USDC amount for initial deposit (6 decimals, min 10e6)
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
    }

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
        require(bytes(_params.underlying).length > 0, "Underlying required");
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

        // --- Effects ---
        s.hedgePlatformFeesCollected += s.hedgeFeeConfig.eventCreationFee;

        uint256 eventId = ++s.hedgeEventCounter;
        s.totalHedgeEvents++;

        _initHedgeEvent(s, eventId, _params);

        uint256 depositId = _createInitialDeposit(s, eventId, _params.initialLiquidity);

        // --- Interactions ---
        uint256 totalAmount = s.hedgeFeeConfig.eventCreationFee + _params.initialLiquidity;
        IERC20(s.usdcToken).safeTransferFrom(msg.sender, address(this), totalAmount);

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

    function _initHedgeEvent(
        LibAppStorage.AppStorage storage s,
        uint256 eventId,
        CreateEventParams memory _params
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
        s.hedgeCreatorEventIds[msg.sender].push(eventId);
    }

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
     * @notice Toggle pool settings (only event creator)
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
     * @notice Deposit USDC liquidity into a hedge event pool
     * @param _eventId The event to deposit into
     * @param _amount USDC amount (6 decimals, min 10e6)
     *
     * Capped at MAX_DEPOSITS_PER_EVENT to bound gas cost of _distributePremiumToLps().
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
        IERC20(s.usdcToken).safeTransferFrom(msg.sender, address(this), _amount);

        emit LiquidityDeposited(_eventId, depositId, msg.sender, _amount, shares);

        return depositId;
    }

    // ============================================================
    //                    BUY PROTECTION
    // ============================================================

    /**
     * @notice Buy FX protection (hedger)
     * @param _eventId Event to hedge against
     * @param _notional Coverage amount in USDC (6 decimals, min 10e6)
     *
     * Payout is predetermined at purchase time:
     *   upward hedge:   payout = notional × (strike - initialRate) / initialRate
     *   downward hedge: payout = notional × (initialRate - strike) / initialRate
     *
     * Capped at MAX_POSITIONS_PER_EVENT to bound gas cost of settleEvent().
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
        s.hedgePlatformFeesCollected += (platformFee - creatorReward);

        // --- Interactions ---
        IERC20(s.usdcToken).safeTransferFrom(msg.sender, address(this), totalCost);

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
     * @notice Settle an event with the FX oracle price (one-touch or at expiry)
     * @param _eventId Event to settle
     * @param _settlementPrice Actual FX rate (6 decimals)
     *
     * Loop is bounded by MAX_POSITIONS_PER_EVENT enforced in buyProtection().
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
     * @notice Claim payout after a winning settlement
     * @param _positionId Position to claim
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
        s.hedgePlatformFeesCollected += (payoutFee - creatorReward);

        pos.claimed = true;
        pos.status = LibAppStorage.HedgePositionStatus.Claimed;

        IERC20(s.usdcToken).safeTransfer(msg.sender, netPayout);

        emit PayoutClaimed(_positionId, msg.sender, grossPayout, payoutFee, netPayout);
    }

    // ============================================================
    //                    LP CLAIM PREMIUMS
    // ============================================================

    /**
     * @notice Claim earned premiums (LP)
     * @param _depositId LP deposit to claim from
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
        s.hedgePlatformFeesCollected += (lpFee - creatorReward);

        dep.premiumsClaimed += claimable;

        IERC20(s.usdcToken).safeTransfer(msg.sender, netAmount);

        emit PremiumsClaimed(_depositId, msg.sender, claimable, lpFee, netAmount);
    }

    // ============================================================
    //                    LP WITHDRAW CAPITAL
    // ============================================================

    /**
     * @notice Withdraw deposited capital (LP)
     * @param _depositId LP deposit to withdraw
     *
     * Precision fix: LP payout share computed in a single multiplication before division
     * to avoid compounding truncation errors from two sequential divisions.
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
            // Single-step calculation avoids double-division precision loss
            uint256 lpPayoutShare = (evt.totalMaxPayout * dep.amount) / evt.totalLiquidity;
            if (lpPayoutShare > withdrawAmount) {
                withdrawAmount = 0;
            } else {
                withdrawAmount -= lpPayoutShare;
            }
        }

        if (withdrawAmount > 0) {
            IERC20(s.usdcToken).safeTransfer(msg.sender, withdrawAmount);
        }

        emit CapitalWithdrawn(_depositId, msg.sender, withdrawAmount);
    }

    // ============================================================
    //                    CREATOR WITHDRAW EARNINGS
    // ============================================================

    /**
     * @notice Creator withdraws their accumulated loyalty earnings
     */
    function withdrawCreatorEarnings(uint256 _eventId) external nonReentrant {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];

        require(evt.id > 0, "Event not found");
        require(msg.sender == evt.creator, "Not creator");
        require(evt.creatorEarnings > 0, "No earnings");

        uint256 amount = evt.creatorEarnings;
        evt.creatorEarnings = 0;

        IERC20(s.usdcToken).safeTransfer(msg.sender, amount);

        emit CreatorEarningsWithdrawn(_eventId, msg.sender, amount);
    }

    // ============================================================
    //                    VIEW FUNCTIONS
    // ============================================================

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

    function getEventPositionIds(uint256 _eventId) external view returns (uint256[] memory) {
        return LibAppStorage.appStorage().hedgeEventPositionIds[_eventId];
    }

    function getEventDepositIds(uint256 _eventId) external view returns (uint256[] memory) {
        return LibAppStorage.appStorage().hedgeEventDepositIds[_eventId];
    }

    function getCreatorEventIds(address _creator) external view returns (uint256[] memory) {
        return LibAppStorage.appStorage().hedgeCreatorEventIds[_creator];
    }

    function getHedgerPositionIds(address _hedger) external view returns (uint256[] memory) {
        return LibAppStorage.appStorage().hedgerPositionIds[_hedger];
    }

    function getLpDepositIds(address _lp) external view returns (uint256[] memory) {
        return LibAppStorage.appStorage().lpDepositIds[_lp];
    }

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

    function getHedgePlatformFees() external view returns (uint256) {
        return LibAppStorage.appStorage().hedgePlatformFeesCollected;
    }

    function getTotalHedgeEvents() external view returns (uint256) {
        return LibAppStorage.appStorage().totalHedgeEvents;
    }

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
     * @dev Distribute premium proportionally to all active LPs.
     *      Loop bounded by MAX_DEPOSITS_PER_EVENT (enforced in deposit()).
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
     * @dev Get total active shares for an event.
     *      Loop bounded by MAX_DEPOSITS_PER_EVENT (enforced in deposit()).
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
