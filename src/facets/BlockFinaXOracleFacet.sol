// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {LibAppStorage} from "../libraries/LibAppStorage.sol";
import {LibOracleStorage} from "../libraries/LibOracleStorage.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

/**
 * @title BlockFinaXOracleFacet
 * @author BlockFinaX Protocol
 * @notice Multi-signer oracle facet for the BlockFinaX Diamond.
 *         Provides decentralised, consensus-gated settlement for hedge events.
 *
 * @dev Isolation guarantee:
 *      This facet is a pure additive upgrade. It does not modify any existing facet
 *      or library file. It uses LibOracleStorage (its own Diamond storage slot, keyed
 *      by a unique keccak256 position) and only touches LibAppStorage to write
 *      settlement results — using the exact same fields that HedgeFacet.settleEvent()
 *      writes, ensuring full compatibility with claimPayout, claimPremiums, and
 *      withdrawCapital.
 *
 *      Settlement flow:
 *        1. Owner registers up to MAX_ORACLES (10) oracle wallets via addOracle().
 *        2. Owner sets requiredSigners (default 2) and toleranceBps (default 100 = 1%).
 *        3. Each oracle node independently calls submitRate(eventId, price) when it
 *           detects the strike has been touched or the event is approaching expiry.
 *        4. On each submitRate() call, _checkConsensus() runs automatically:
 *           a. Collects all non-stale submissions (age <= STALE_THRESHOLD = 15 min).
 *           b. If fewer than requiredSigners valid submissions exist, exits silently.
 *           c. Computes spread = (max - min) / min * 10000 (basis points).
 *           d. If spread > toleranceBps: clears all submissions, emits SubmissionsCleared.
 *              Oracles must resubmit after their next poll cycle.
 *           e. If spread <= toleranceBps: computes average price, settles the event,
 *              emits ConsensusReached and OracleEventSettled.
 *        5. If oracles disagree persistently or one goes offline, the owner can call
 *           clearStaleSubmissions() to manually clear the stuck state and let the
 *           remaining active oracles resubmit.
 *
 *      Coexistence with HedgeFacet.settleEvent():
 *        Both settlement paths write to the same AppStorage fields and can coexist.
 *        The existing single-key path (hedgeOracleAdmin) continues to function unchanged.
 *        Once all oracle wallets are registered and tested, migrate settlement exclusively
 *        to this facet by setting hedgeOracleAdmin = address(0) via setOracleAdmin().
 *
 *      Gas safety:
 *        The oracle registry is capped at MAX_ORACLES = 10, bounding the _checkConsensus()
 *        and removeOracle() loops. The _settleEvent() loop is bounded by
 *        HedgeFacet.MAX_POSITIONS_PER_EVENT = 500.
 */
contract BlockFinaXOracleFacet {
    /// @dev Submissions older than this threshold (seconds) are excluded from consensus.
    uint256 constant STALE_THRESHOLD = 15 * 60;

    /// @dev Minimum time (seconds) an oracle must wait before overwriting its own submission
    ///      for the same event. Prevents a malicious/faulty oracle from rapidly oscillating
    ///      between prices to repeatedly clear consensus and DoS settlement.
    uint256 constant RESUBMIT_COOLDOWN = 5 * 60;

    /// @dev Maximum number of oracle wallets that can be registered.
    ///      Bounds the loop in _checkConsensus() and removeOracle().
    uint256 constant MAX_ORACLES = 10;

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when a new oracle wallet is registered.
    event OracleAdded(address indexed oracle);

    /// @notice Emitted when an oracle wallet is deregistered.
    event OracleRemoved(address indexed oracle);

    /// @notice Emitted when requiredSigners or toleranceBps is updated.
    event OracleConfigUpdated(uint256 requiredSigners, uint256 toleranceBps);

    /// @notice Emitted when an oracle submits a price reading for an event.
    event RateSubmitted(
        uint256 indexed eventId,
        address indexed oracle,
        uint256 price
    );

    /// @notice Emitted when sufficient agreeing submissions trigger automatic settlement.
    event ConsensusReached(
        uint256 indexed eventId,
        uint256 agreedPrice,
        uint256 signerCount
    );

    /// @notice Emitted when submissions are cleared due to disagreement or manual admin action.
    event SubmissionsCleared(
        uint256 indexed eventId,
        string reason
    );

    /// @notice Emitted when an event is successfully settled via oracle consensus.
    event OracleEventSettled(
        uint256 indexed eventId,
        uint256 settlementPrice,
        bool triggered
    );

    // ============================================================
    //                        MODIFIERS
    // ============================================================

    /// @dev Restricts access to the Diamond contract owner.
    modifier onlyOwner() {
        require(msg.sender == LibDiamond.contractOwner(), "Not owner");
        _;
    }

    /// @dev Restricts access to wallets registered via addOracle().
    modifier onlyAuthorisedOracle() {
        require(
            LibOracleStorage.oracleStorage().isOracle[msg.sender],
            "Not an authorised oracle"
        );
        _;
    }

    // H003: shared reentrancy guard using the same AppStorage lock as HedgeFacet,
    // so the lock is respected across all facets (Diamond cross-facet protection).
    modifier nonReentrant() {
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();
        require(!s.hedgeReentrancyLock, "Reentrant call");
        s.hedgeReentrancyLock = true;
        _;
        s.hedgeReentrancyLock = false;
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /**
     * @notice Register a new oracle wallet authorised to submit price readings.
     * @dev Capped at MAX_ORACLES (10) to prevent gas DoS in _checkConsensus().
     *      Sets default config (requiredSigners = 2, toleranceBps = 100) on first registration
     *      if not already configured.
     *      After adding oracles, call setRequiredSigners() to update the threshold.
     *
     * @param _oracle Wallet address that will call submitRate(). Cannot be address(0).
     */
    function addOracle(address _oracle) external onlyOwner {
        LibOracleStorage.OracleStorage storage os = LibOracleStorage.oracleStorage();
        require(_oracle != address(0), "Zero address");
        require(!os.isOracle[_oracle], "Already registered");
        require(os.oracles.length < MAX_ORACLES, "Max oracle count reached (10)");

        os.oracles.push(_oracle);
        os.isOracle[_oracle] = true;

        // M-7 fix: emit OracleConfigUpdated when defaults are initialised on first addOracle().
        // Without this event, off-chain monitors have no way to discover the effective
        // requiredSigners and toleranceBps values unless they query getOracleConfig().
        bool configChanged = false;
        if (os.requiredSigners == 0) { os.requiredSigners = 2; configChanged = true; }
        if (os.toleranceBps == 0)    { os.toleranceBps = 100; configChanged = true; }
        if (configChanged) {
            emit OracleConfigUpdated(os.requiredSigners, os.toleranceBps);
        }

        emit OracleAdded(_oracle);
    }

    /**
     * @notice Deregister an oracle wallet, removing its submission privileges.
     * @dev Uses swap-and-pop to remove from the oracles array in O(n) time.
     *      Pending submissions from the removed oracle are not automatically cleared —
     *      call clearStaleSubmissions() if needed to force a clean slate.
     *      Ensure requiredSigners <= remaining oracle count after removal.
     *
     * @param _oracle The wallet address to deregister. Must currently be registered.
     */
    function removeOracle(address _oracle) external onlyOwner {
        LibOracleStorage.OracleStorage storage os = LibOracleStorage.oracleStorage();
        require(os.isOracle[_oracle], "Not registered");

        os.isOracle[_oracle] = false;
        // G001: cache length; G011: pre-increment.
        uint256 len = os.oracles.length;
        for (uint256 i = 0; i < len; ++i) {
            if (os.oracles[i] == _oracle) {
                os.oracles[i] = os.oracles[len - 1];
                os.oracles.pop();
                break;
            }
        }

        // M-6 fix: after removing an oracle, verify the remaining oracle count still
        // satisfies the configured requiredSigners threshold. Without this guard, an owner
        // could accidentally create a configuration where consensus is mathematically
        // impossible (e.g. requiredSigners = 3 but only 2 oracles remain), permanently
        // blocking settlement via the multi-oracle path.
        require(
            os.oracles.length >= os.requiredSigners,
            "Removing this oracle would violate quorum (oracle count would drop below requiredSigners)"
        );

        emit OracleRemoved(_oracle);
    }

    /**
     * @notice Set the minimum number of agreeing oracle submissions required for consensus.
     * @dev Must be >= 1 and <= the current number of registered oracles.
     *      A value of 2 out of 3 oracles is recommended for mainnet (2-of-3 multisig equivalent).
     *      Changes take effect for all subsequent submitRate() calls.
     *
     * @param _required New required signer count.
     */
    function setRequiredSigners(uint256 _required) external onlyOwner {
        LibOracleStorage.OracleStorage storage os = LibOracleStorage.oracleStorage();
        require(_required >= 2, "Minimum 2 signers required");
        require(_required <= os.oracles.length, "Exceeds oracle count");
        os.requiredSigners = _required;
        emit OracleConfigUpdated(os.requiredSigners, os.toleranceBps);
    }

    /**
     * @notice Set the maximum allowed price spread between oracle submissions for consensus.
     * @dev Spread is computed as (maxPrice - minPrice) * 10000 / minPrice (basis points).
     *      If the spread across valid submissions exceeds this threshold, all submissions
     *      are cleared and oracles must resubmit. Capped at 1000 bps (10%).
     *      100 bps (1%) is the recommended mainnet setting.
     *
     * @param _bps Tolerance in basis points (e.g. 100 = 1%). Maximum 1000 (10%).
     */
    function setToleranceBps(uint256 _bps) external onlyOwner {
        LibOracleStorage.OracleStorage storage os = LibOracleStorage.oracleStorage();
        require(_bps <= 1000, "Max 10% tolerance");
        os.toleranceBps = _bps;
        emit OracleConfigUpdated(os.requiredSigners, os.toleranceBps);
    }

    /**
     * @notice Manually clear all pending oracle submissions for an event.
     * @dev Use this to recover from a stuck state where stale submissions prevent
     *      consensus from ever being reached — for example, when an oracle node goes
     *      offline after submitting but before enough other oracles have submitted.
     *      After clearing, active oracle nodes must resubmit.
     *      Only valid for events that are still Open.
     *
     * @param _eventId The hedge event ID whose submissions should be cleared.
     */
    function clearStaleSubmissions(uint256 _eventId) external onlyOwner {
        LibOracleStorage.OracleStorage storage os = LibOracleStorage.oracleStorage();
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();

        require(s.hedgeEvents[_eventId].id > 0, "Event not found");
        require(
            s.hedgeEvents[_eventId].status == LibAppStorage.HedgeEventStatus.Open,
            "Event already settled"
        );

        address[] storage submitters = os.submitters[_eventId];
        require(submitters.length > 0, "No submissions to clear");

        // Admin-forced clear: isDisagreement=false so oracle cooldown timestamps are also
        // cleared. The whole point of a manual clear is to let oracles resubmit immediately
        // without waiting for the RESUBMIT_COOLDOWN to expire.
        _clearSubmissions(_eventId, submitters, os, false);
        emit SubmissionsCleared(_eventId, "Manually cleared by admin");
    }

    // ============================================================
    //                     ORACLE SUBMISSION
    // ============================================================

    /**
     * @notice Submit a current market price reading for a hedge event.
     *         Consensus and automatic settlement execute within the same transaction
     *         if the required number of agreeing submissions have been collected.
     *
     * @dev Only registered oracle wallets may call this function.
     *      An oracle can update its own submission by calling again (overwrite).
     *      Stale submissions (older than STALE_THRESHOLD = 15 min) are excluded from
     *      consensus counting even if they remain in storage.
     *      After submitting, _checkConsensus() is called automatically.
     *
     * @param _eventId The ID of the hedge event to submit a price for.
     * @param _price   Current market price in 6-decimal units (same scale as strike price).
     *                 Must be > 0.
     */
    // H003: nonReentrant guards against cross-function re-entrancy. submitRate calls
    // _checkConsensus which calls _settleEvent — all within one atomic transaction.
    // The shared AppStorage lock blocks any re-entrant call into HedgeFacet or this facet.
    function submitRate(uint256 _eventId, uint256 _price)
        external
        onlyAuthorisedOracle
        nonReentrant
    {
        LibOracleStorage.OracleStorage storage os = LibOracleStorage.oracleStorage();
        LibAppStorage.AppStorage storage s = LibAppStorage.appStorage();

        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];
        require(evt.id > 0, "Event not found");
        require(
            evt.status == LibAppStorage.HedgeEventStatus.Open,
            "Event not open"
        );
        require(_price > 0, "Invalid price");

        // European-style settlement: oracles may only submit (and therefore settle) at or
        // after the event's expiry date. A strike touched before expiry does NOT settle the
        // event early — this mirrors the same guard in HedgeFacet.settleEvent() so both
        // settlement paths defer payout until expiry.
        require(
            block.timestamp >= evt.expiryDate,
            "Too early: settlement only allowed at or after expiry"
        );

        // Resubmission cooldown: applies to ALL submissions, including those in a new round
        // after a previous round was cleared. This prevents a malicious oracle from rapidly
        // cycling through submission rounds (submit → clear-by-disagreement → resubmit → repeat)
        // to perpetually block consensus (DoS attack vector).
        uint256 lastSubmit = os.lastSubmitTime[_eventId][msg.sender];
        if (lastSubmit > 0) {
            require(
                block.timestamp >= lastSubmit + RESUBMIT_COOLDOWN,
                "Resubmit cooldown: wait 5 minutes between submissions for this event"
            );
        }

        if (!os.submissions[_eventId][msg.sender].exists) {
            os.submitters[_eventId].push(msg.sender);
        }

        os.lastSubmitTime[_eventId][msg.sender] = block.timestamp;
        os.submissions[_eventId][msg.sender] = LibOracleStorage.Submission({
            price: _price,
            timestamp: block.timestamp,
            exists: true
        });

        emit RateSubmitted(_eventId, msg.sender, _price);

        _checkConsensus(_eventId, os, s);
    }

    // ============================================================
    //                    INTERNAL CONSENSUS
    // ============================================================

    /**
     * @dev Evaluate whether current submissions meet the consensus threshold.
     *      Called automatically after every submitRate().
     *
     *      Algorithm:
     *        1. Count non-stale submissions. Exit if < requiredSigners.
     *        2. Find min, max, and sum of valid prices.
     *        3. Compute spread = (max - min) * 10000 / min (basis points).
     *        4. If spread > toleranceBps: clear submissions, return.
     *        5. Compute agreedPrice = sum / validCount (integer average).
     *        6. Clear submissions, then call _settleEvent().
     *
     *      Clearing submissions before _settleEvent() prevents any reuse of
     *      submissions across multiple settlement attempts.
     *
     * @param _eventId The event being evaluated.
     * @param os       Reference to OracleStorage.
     * @param s        Reference to AppStorage.
     */
    function _checkConsensus(
        uint256 _eventId,
        LibOracleStorage.OracleStorage storage os,
        LibAppStorage.AppStorage storage s
    ) internal {
        address[] storage submitters = os.submitters[_eventId];
        uint256 submitterCount = submitters.length;
        uint256 required = os.requiredSigners;

        if (submitterCount < required) return;

        // Pass 1: count non-stale submissions before allocating memory.
        // This avoids over-allocating a `submitterCount`-length array when some entries are stale,
        // which would leave trailing zero slots that could mislead readers of the array.
        uint256 validCount = 0;
        // G001: submitterCount cached above; G011: pre-increment.
        for (uint256 i = 0; i < submitterCount; ++i) {
            LibOracleStorage.Submission storage sub =
                os.submissions[_eventId][submitters[i]];
            if (sub.exists && (block.timestamp - sub.timestamp) <= STALE_THRESHOLD) {
                ++validCount;
            }
        }

        if (validCount < required) return;

        // Pass 2: collect exactly `validCount` valid prices into a correctly-sized array.
        uint256[] memory validPrices = new uint256[](validCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < submitterCount; ++i) {
            LibOracleStorage.Submission storage sub =
                os.submissions[_eventId][submitters[i]];
            if (sub.exists && (block.timestamp - sub.timestamp) <= STALE_THRESHOLD) {
                validPrices[idx] = sub.price;
                ++idx;
            }
        }

        uint256 minPrice = validPrices[0];
        uint256 maxPrice = validPrices[0];
        uint256 sum = validPrices[0];
        // Defensive guard: submitRate enforces _price > 0, so minPrice can never be zero,
        // but we assert explicitly to make the invariant clear to auditors.
        require(minPrice > 0, "Zero price in valid submission set");

        // G001: validCount is a stack variable; G011: pre-increment.
        for (uint256 i = 1; i < validCount; ++i) {
            if (validPrices[i] < minPrice) minPrice = validPrices[i];
            if (validPrices[i] > maxPrice) maxPrice = validPrices[i];
            sum += validPrices[i];
        }

        uint256 spread = ((maxPrice - minPrice) * 10000) / minPrice;

        if (spread > os.toleranceBps) {
            // H-3 fix: pass isDisagreement=true so _clearSubmissions preserves each oracle's
            // lastSubmitTime. This keeps the RESUBMIT_COOLDOWN active after a disagreement
            // clear, preventing a malicious oracle from rapidly cycling (submit → disagree →
            // resubmit) to perpetually DoS the settlement process.
            _clearSubmissions(_eventId, submitters, os, true);
            emit SubmissionsCleared(_eventId, "Price disagreement exceeds tolerance");
            return;
        }

        uint256 agreedPrice = sum / validCount;

        emit ConsensusReached(_eventId, agreedPrice, validCount);

        // Clear before settling to prevent any re-entrancy on storage state.
        // Pass isDisagreement=false: on successful consensus, delete cooldown timestamps so
        // oracles start fresh if this event somehow needs re-settlement (race condition guard).
        _clearSubmissions(_eventId, submitters, os, false);

        _settleEvent(_eventId, agreedPrice, s);
    }

    /**
     * @dev Delete all submission records for an event and conditionally reset cooldown timestamps.
     *
     * @param _eventId       The event whose submissions are being cleared.
     * @param submitters     Storage reference to the submitters array.
     * @param os             Reference to OracleStorage.
     * @param _isDisagreement H-3 fix: when true (price disagreement), lastSubmitTime is
     *                        PRESERVED so the RESUBMIT_COOLDOWN remains in effect, blocking
     *                        rapid oscillation attacks. When false (successful consensus or
     *                        admin forced clear), lastSubmitTime is deleted to allow immediate
     *                        resubmission in the next round.
     */
    function _clearSubmissions(
        uint256 _eventId,
        address[] storage submitters,
        LibOracleStorage.OracleStorage storage os,
        bool _isDisagreement
    ) internal {
        // G001: cache length; G011: pre-increment.
        uint256 count = submitters.length;
        for (uint256 i = 0; i < count; ++i) {
            address oracle = submitters[i];
            delete os.submissions[_eventId][oracle];
            // H-3 fix: only reset the cooldown timestamp when this is NOT a disagreement
            // clear. On disagreement, preserving lastSubmitTime means the oracle must still
            // wait for the RESUBMIT_COOLDOWN before submitting again, preventing DoS cycling.
            if (!_isDisagreement) {
                delete os.lastSubmitTime[_eventId][oracle];
            }
        }
        delete os.submitters[_eventId];
    }

    /**
     * @dev Write settlement results to AppStorage, mirroring the logic of
     *      HedgeFacet.settleEvent() exactly so that downstream claim and withdraw
     *      functions behave identically regardless of which path settled the event.
     *
     *      Guards against double-settlement with an early return if the event is
     *      no longer Open (e.g. settled by the single-key oracle in a race condition).
     *
     *      The position loop is bounded by HedgeFacet.MAX_POSITIONS_PER_EVENT = 500.
     *
     * @param _eventId         The event to settle.
     * @param _settlementPrice The consensus-agreed price (6 decimals).
     * @param s                Reference to AppStorage.
     */
    function _settleEvent(
        uint256 _eventId,
        uint256 _settlementPrice,
        LibAppStorage.AppStorage storage s
    ) internal {
        LibAppStorage.HedgeEvent storage evt = s.hedgeEvents[_eventId];

        if (evt.status != LibAppStorage.HedgeEventStatus.Open) return;

        bool triggered = evt.strikeAbove
            ? _settlementPrice >= evt.strike
            : _settlementPrice <= evt.strike;

        evt.status = LibAppStorage.HedgeEventStatus.Settled;
        evt.settlementPrice = _settlementPrice;
        evt.triggered = triggered;
        evt.settledAt = block.timestamp;

        // C-1 fix: snapshot totalLiquidity at settlement time so withdrawCapital() can use
        // a consistent denominator regardless of how many LPs have already withdrawn.
        // Mirrors the same fix applied in HedgeFacet.settleEvent().
        evt.liquidityAtSettlement = evt.totalLiquidity;

        // v7 range product: mirror HedgeFacet.settleEvent() exactly so consensus settlement
        // and single-key settlement produce identical position state. See HedgeFacet for the
        // commentary on the geometry.
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
        // G001: cache array length; G011: pre-increment.
        uint256 posCount = positionIds.length;
        uint256 totalActualPayout = 0;
        for (uint256 i = 0; i < posCount; ++i) {
            LibAppStorage.HedgePosition storage pos =
                s.hedgePositions[positionIds[i]];
            if (pos.status != LibAppStorage.HedgePositionStatus.Active) continue;

            if (!triggered) {
                pos.payoutAmount = 0;
                pos.status = LibAppStorage.HedgePositionStatus.Expired;
                continue;
            }

            uint256 actualPayout;
            if (evt.payoutCap == 0) {
                actualPayout = pos.payoutAmount; // legacy
            } else {
                actualPayout = (pos.notional * effectivePriceMove) / evt.initialRate;
            }

            pos.payoutAmount = actualPayout;
            if (actualPayout > 0) {
                pos.status = LibAppStorage.HedgePositionStatus.Claimable;
                totalActualPayout += actualPayout;
            } else {
                pos.status = LibAppStorage.HedgePositionStatus.Expired;
            }
        }

        evt.totalMaxPayout = totalActualPayout;

        emit OracleEventSettled(_eventId, _settlementPrice, triggered);
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /**
     * @notice Get the list of all currently registered oracle wallet addresses.
     * @return Array of registered oracle addresses.
     */
    function getOracles() external view returns (address[] memory) {
        return LibOracleStorage.oracleStorage().oracles;
    }

    /**
     * @notice Get the current oracle consensus configuration.
     * @return requiredSigners Minimum agreeing submissions needed for consensus.
     * @return toleranceBps    Maximum allowed price spread in basis points (e.g. 100 = 1%).
     * @return oracleCount     Number of currently registered oracle wallets.
     * @return maxOracles      Hard cap on oracle wallets (MAX_ORACLES = 10).
     */
    function getOracleConfig()
        external
        view
        returns (
            uint256 requiredSigners,
            uint256 toleranceBps,
            uint256 oracleCount,
            uint256 maxOracles
        )
    {
        LibOracleStorage.OracleStorage storage os = LibOracleStorage.oracleStorage();
        return (os.requiredSigners, os.toleranceBps, os.oracles.length, MAX_ORACLES);
    }

    /**
     * @notice Check whether an address is a registered oracle wallet.
     * @param _oracle The address to check.
     * @return True if the address is authorised to call submitRate().
     */
    function isAuthorisedOracle(address _oracle)
        external
        view
        returns (bool)
    {
        return LibOracleStorage.oracleStorage().isOracle[_oracle];
    }

    /**
     * @notice Get the submission details for a specific oracle on a specific event.
     * @param _eventId The hedge event ID.
     * @param _oracle  The oracle wallet address.
     * @return price     The price submitted by this oracle (6 decimals). 0 if no submission.
     * @return timestamp Unix timestamp when the submission was recorded.
     * @return exists    Whether a submission exists for this oracle on this event.
     * @return isStale   Whether the submission is older than STALE_THRESHOLD (15 minutes).
     */
    function getSubmission(uint256 _eventId, address _oracle)
        external
        view
        returns (
            uint256 price,
            uint256 timestamp,
            bool exists,
            bool isStale
        )
    {
        LibOracleStorage.Submission storage sub =
            LibOracleStorage.oracleStorage().submissions[_eventId][_oracle];
        bool stale = sub.exists &&
            (block.timestamp - sub.timestamp) > STALE_THRESHOLD;
        return (sub.price, sub.timestamp, sub.exists, stale);
    }

    /**
     * @notice Get the number of oracles that have submitted a price for an event.
     * @dev Includes stale submissions. Use getAllSubmissions() to check staleness.
     * @param _eventId The hedge event ID.
     * @return Number of oracles with a submission on record for this event.
     */
    function getSubmitterCount(uint256 _eventId)
        external
        view
        returns (uint256)
    {
        return LibOracleStorage.oracleStorage().submitters[_eventId].length;
    }

    /**
     * @notice Get all current oracle submissions for a hedge event.
     * @param _eventId The hedge event ID.
     * @return oracleAddresses Array of oracle wallet addresses that have submitted.
     * @return prices          Array of submitted prices (6 decimals), parallel to oracleAddresses.
     * @return timestamps      Array of submission timestamps, parallel to oracleAddresses.
     * @return isStale         Array of staleness flags (true if age > 15 min), parallel to oracleAddresses.
     */
    function getAllSubmissions(uint256 _eventId)
        external
        view
        returns (
            address[] memory oracleAddresses,
            uint256[] memory prices,
            uint256[] memory timestamps,
            bool[] memory isStale
        )
    {
        LibOracleStorage.OracleStorage storage os = LibOracleStorage.oracleStorage();
        address[] storage submitters = os.submitters[_eventId];
        uint256 count = submitters.length;

        oracleAddresses = new address[](count);
        prices = new uint256[](count);
        timestamps = new uint256[](count);
        isStale = new bool[](count);

        // G001: count already cached above; G011: pre-increment.
        for (uint256 i = 0; i < count; ++i) {
            LibOracleStorage.Submission storage sub =
                os.submissions[_eventId][submitters[i]];
            oracleAddresses[i] = submitters[i];
            prices[i] = sub.price;
            timestamps[i] = sub.timestamp;
            isStale[i] = (block.timestamp - sub.timestamp) > STALE_THRESHOLD;
        }
    }
}
