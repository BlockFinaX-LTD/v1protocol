// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {LibAppStorage} from "../libraries/LibAppStorage.sol";
import {LibOracleStorage} from "../libraries/LibOracleStorage.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

/**
 * @title BlockFinaXOracleFacet
 * @notice Multi-signer oracle facet for the BlockFinaX Diamond.
 *
 * ISOLATION GUARANTEE
 * -------------------
 * This facet is an additive upgrade. It does not modify any existing facet
 * or library. It uses LibOracleStorage (its own Diamond storage slot) and
 * reads/writes LibAppStorage only to settle events — using the same fields
 * that HedgeFacet.settleEvent() writes, so settlement results are fully
 * compatible with claimPayout / claimPremiums / withdrawCapital.
 *
 * SETTLEMENT FLOW
 * ---------------
 * 1. Admin registers N oracle wallets via addOracle().
 * 2. Admin sets requiredSigners (default 2) and toleranceBps (default 100 = 1%).
 * 3. Each oracle node independently calls submitRate(eventId, price).
 * 4. When requiredSigners submissions exist and all prices agree within
 *    toleranceBps, the facet settles the event automatically at the average price.
 * 5. If submissions disagree (spread > toleranceBps) they are cleared and
 *    nodes must resubmit after their next poll cycle.
 * 6. Stale submissions (older than 15 min) are ignored at consensus check.
 *
 * COMPATIBILITY
 * -------------
 * The existing HedgeFacet.settleEvent() continues to work unchanged via
 * the hedgeOracleAdmin single-key path. Both paths can coexist — once you
 * add oracle wallets to this facet you can migrate settlement exclusively
 * to this path by removing DEPLOYER_PRIVATE_KEY from the single-key oracle.
 */
contract BlockFinaXOracleFacet {
    uint256 constant STALE_THRESHOLD = 15 * 60;

    // ============================================================
    //                          EVENTS
    // ============================================================

    event OracleAdded(address indexed oracle);
    event OracleRemoved(address indexed oracle);
    event OracleConfigUpdated(uint256 requiredSigners, uint256 toleranceBps);

    event RateSubmitted(
        uint256 indexed eventId,
        address indexed oracle,
        uint256 price
    );

    event ConsensusReached(
        uint256 indexed eventId,
        uint256 agreedPrice,
        uint256 signerCount
    );

    event SubmissionsCleared(
        uint256 indexed eventId,
        string reason
    );

    event OracleEventSettled(
        uint256 indexed eventId,
        uint256 settlementPrice,
        bool triggered
    );

    // ============================================================
    //                        MODIFIERS
    // ============================================================

    modifier onlyOwner() {
        require(msg.sender == LibDiamond.contractOwner(), "Not owner");
        _;
    }

    modifier onlyAuthorisedOracle() {
        require(
            LibOracleStorage.oracleStorage().isOracle[msg.sender],
            "Not an authorised oracle"
        );
        _;
    }

    // ============================================================
    //                      ADMIN FUNCTIONS
    // ============================================================

    /**
     * @notice Register a new oracle wallet.
     * @param _oracle Wallet address that will call submitRate().
     */
    function addOracle(address _oracle) external onlyOwner {
        LibOracleStorage.OracleStorage storage os = LibOracleStorage.oracleStorage();
        require(_oracle != address(0), "Zero address");
        require(!os.isOracle[_oracle], "Already registered");

        os.oracles.push(_oracle);
        os.isOracle[_oracle] = true;

        if (os.requiredSigners == 0) os.requiredSigners = 2;
        if (os.toleranceBps == 0) os.toleranceBps = 100;

        emit OracleAdded(_oracle);
    }

    /**
     * @notice Remove an oracle wallet.
     * @param _oracle Wallet to deregister.
     */
    function removeOracle(address _oracle) external onlyOwner {
        LibOracleStorage.OracleStorage storage os = LibOracleStorage.oracleStorage();
        require(os.isOracle[_oracle], "Not registered");

        os.isOracle[_oracle] = false;
        for (uint256 i = 0; i < os.oracles.length; i++) {
            if (os.oracles[i] == _oracle) {
                os.oracles[i] = os.oracles[os.oracles.length - 1];
                os.oracles.pop();
                break;
            }
        }
        emit OracleRemoved(_oracle);
    }

    /**
     * @notice Set how many oracle submissions are needed for consensus.
     * @param _required Must be >= 1 and <= registered oracle count.
     */
    function setRequiredSigners(uint256 _required) external onlyOwner {
        LibOracleStorage.OracleStorage storage os = LibOracleStorage.oracleStorage();
        require(_required >= 1, "Minimum 1 signer");
        require(_required <= os.oracles.length, "Exceeds oracle count");
        os.requiredSigners = _required;
        emit OracleConfigUpdated(os.requiredSigners, os.toleranceBps);
    }

    /**
     * @notice Set the maximum allowed price spread between submissions.
     * @param _bps Spread in basis points (e.g. 100 = 1%). Max 1000 (10%).
     */
    function setToleranceBps(uint256 _bps) external onlyOwner {
        LibOracleStorage.OracleStorage storage os = LibOracleStorage.oracleStorage();
        require(_bps <= 1000, "Max 10% tolerance");
        os.toleranceBps = _bps;
        emit OracleConfigUpdated(os.requiredSigners, os.toleranceBps);
    }

    // ============================================================
    //                     ORACLE SUBMISSION
    // ============================================================

    /**
     * @notice Submit a price reading for a hedge event.
     *         Settlement executes automatically when consensus is reached.
     *
     * @param _eventId  The hedge event to submit a rate for.
     * @param _price    Current market price in 6-decimal USDC units (same as HedgeFacet).
     */
    function submitRate(uint256 _eventId, uint256 _price)
        external
        onlyAuthorisedOracle
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

        if (!os.submissions[_eventId][msg.sender].exists) {
            os.submitters[_eventId].push(msg.sender);
        }

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

    function _checkConsensus(
        uint256 _eventId,
        LibOracleStorage.OracleStorage storage os,
        LibAppStorage.AppStorage storage s
    ) internal {
        address[] storage submitters = os.submitters[_eventId];
        uint256 submitterCount = submitters.length;
        uint256 required = os.requiredSigners;

        if (submitterCount < required) return;

        uint256[] memory validPrices = new uint256[](submitterCount);
        uint256 validCount = 0;

        for (uint256 i = 0; i < submitterCount; i++) {
            LibOracleStorage.Submission storage sub =
                os.submissions[_eventId][submitters[i]];
            if (
                sub.exists &&
                (block.timestamp - sub.timestamp) <= STALE_THRESHOLD
            ) {
                validPrices[validCount] = sub.price;
                validCount++;
            }
        }

        if (validCount < required) return;

        uint256 minPrice = validPrices[0];
        uint256 maxPrice = validPrices[0];
        uint256 sum = validPrices[0];

        for (uint256 i = 1; i < validCount; i++) {
            if (validPrices[i] < minPrice) minPrice = validPrices[i];
            if (validPrices[i] > maxPrice) maxPrice = validPrices[i];
            sum += validPrices[i];
        }

        uint256 spread = ((maxPrice - minPrice) * 10000) / minPrice;

        if (spread > os.toleranceBps) {
            _clearSubmissions(_eventId, submitters, os);
            emit SubmissionsCleared(_eventId, "Price disagreement exceeds tolerance");
            return;
        }

        uint256 agreedPrice = sum / validCount;

        emit ConsensusReached(_eventId, agreedPrice, validCount);

        _clearSubmissions(_eventId, submitters, os);

        _settleEvent(_eventId, agreedPrice, s);
    }

    function _clearSubmissions(
        uint256 _eventId,
        address[] storage submitters,
        LibOracleStorage.OracleStorage storage os
    ) internal {
        for (uint256 i = 0; i < submitters.length; i++) {
            delete os.submissions[_eventId][submitters[i]];
        }
        delete os.submitters[_eventId];
    }

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

        uint256[] storage positionIds = s.hedgeEventPositionIds[_eventId];
        for (uint256 i = 0; i < positionIds.length; i++) {
            LibAppStorage.HedgePosition storage pos =
                s.hedgePositions[positionIds[i]];
            if (pos.status != LibAppStorage.HedgePositionStatus.Active) continue;

            if (triggered) {
                pos.status = LibAppStorage.HedgePositionStatus.Claimable;
            } else {
                pos.payoutAmount = 0;
                pos.status = LibAppStorage.HedgePositionStatus.Expired;
            }
        }

        emit OracleEventSettled(_eventId, _settlementPrice, triggered);
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    function getOracles() external view returns (address[] memory) {
        return LibOracleStorage.oracleStorage().oracles;
    }

    function getOracleConfig()
        external
        view
        returns (
            uint256 requiredSigners,
            uint256 toleranceBps,
            uint256 oracleCount
        )
    {
        LibOracleStorage.OracleStorage storage os = LibOracleStorage.oracleStorage();
        return (os.requiredSigners, os.toleranceBps, os.oracles.length);
    }

    function isAuthorisedOracle(address _oracle)
        external
        view
        returns (bool)
    {
        return LibOracleStorage.oracleStorage().isOracle[_oracle];
    }

    function getSubmission(uint256 _eventId, address _oracle)
        external
        view
        returns (
            uint256 price,
            uint256 timestamp,
            bool exists
        )
    {
        LibOracleStorage.Submission storage sub =
            LibOracleStorage.oracleStorage().submissions[_eventId][_oracle];
        return (sub.price, sub.timestamp, sub.exists);
    }

    function getSubmitterCount(uint256 _eventId)
        external
        view
        returns (uint256)
    {
        return LibOracleStorage.oracleStorage().submitters[_eventId].length;
    }

    function getAllSubmissions(uint256 _eventId)
        external
        view
        returns (
            address[] memory oracleAddresses,
            uint256[] memory prices,
            uint256[] memory timestamps
        )
    {
        LibOracleStorage.OracleStorage storage os = LibOracleStorage.oracleStorage();
        address[] storage submitters = os.submitters[_eventId];
        uint256 count = submitters.length;

        oracleAddresses = new address[](count);
        prices = new uint256[](count);
        timestamps = new uint256[](count);

        for (uint256 i = 0; i < count; i++) {
            LibOracleStorage.Submission storage sub =
                os.submissions[_eventId][submitters[i]];
            oracleAddresses[i] = submitters[i];
            prices[i] = sub.price;
            timestamps[i] = sub.timestamp;
        }
    }
}
