// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LibOracleStorage
 * @author BlockFinaX Protocol
 * @notice Isolated Diamond Storage library for the multi-signer BlockFinaXOracleFacet.
 *
 * @dev This library occupies its own unique storage slot (ORACLE_STORAGE_POSITION),
 *      completely separate from LibAppStorage (APP_STORAGE_POSITION) and LibDiamond
 *      (diamond.standard.diamond.storage). This guarantees zero storage collision with
 *      any existing or future facets.
 *
 *      Deployment path:
 *        - Only BlockFinaXOracleFacet reads this library.
 *        - No existing facets are modified or aware of this library.
 *        - Adding the OracleFacet via diamondCut() is a pure additive upgrade.
 *
 *      Storage contents:
 *        - Registry of authorised oracle wallet addresses.
 *        - Consensus parameters (requiredSigners, toleranceBps).
 *        - Per-event submission records (price, timestamp, oracle address).
 */
library LibOracleStorage {
    /// @dev Unique storage slot for OracleStorage.
    ///      Deliberately distinct from LibAppStorage ("blockfinax.app.storage") and
    ///      LibDiamond ("diamond.standard.diamond.storage") to prevent slot collision.
    bytes32 constant ORACLE_STORAGE_POSITION =
        keccak256("blockfinax.oracle.v2.storage");

    /**
     * @notice A single oracle price submission for a specific hedge event.
     *
     * @param price     The market price submitted by the oracle (6 decimals, same scale as strike).
     * @param timestamp Unix timestamp when this submission was recorded on-chain.
     * @param exists    True if this oracle has an active (non-cleared) submission for this event.
     *                  Used to avoid pushing duplicate entries to the submitters array.
     */
    struct Submission {
        uint256 price;
        uint256 timestamp;
        bool exists;
    }

    /**
     * @notice Root storage struct for the oracle consensus system.
     *
     * @param oracles          Ordered array of registered oracle wallet addresses.
     *                         Capped at BlockFinaXOracleFacet.MAX_ORACLES (10).
     * @param isOracle         O(1) lookup for whether an address is a registered oracle.
     * @param requiredSigners  Minimum number of non-stale, agreeing submissions needed to
     *                         trigger automatic settlement. Default: 2 (set on first addOracle()).
     * @param toleranceBps     Maximum allowed spread between submissions in basis points
     *                         before consensus is rejected and submissions are cleared.
     *                         E.g. 100 = 1% tolerance. Default: 100. Maximum: 1000 (10%).
     * @param submissions      Per-event, per-oracle submission records.
     *                         submissions[eventId][oracleAddress] = Submission.
     *                         Cleared atomically after consensus or disagreement.
     * @param submitters       Ordered list of oracle addresses that have submitted for each event.
     *                         submitters[eventId] is cleared alongside submissions after each round.
     *                         Used to iterate over active submissions in _checkConsensus().
     */
    struct OracleStorage {
        address[] oracles;
        mapping(address => bool) isOracle;
        uint256 requiredSigners;
        uint256 toleranceBps;
        mapping(uint256 => mapping(address => Submission)) submissions;
        mapping(uint256 => address[]) submitters;
    }

    /**
     * @notice Returns a storage pointer to the OracleStorage struct.
     * @dev Uses inline assembly to point to the deterministic ORACLE_STORAGE_POSITION slot.
     *      This is the standard Diamond Storage access pattern from EIP-2535.
     * @return s Storage pointer to OracleStorage.
     */
    function oracleStorage()
        internal
        pure
        returns (OracleStorage storage s)
    {
        bytes32 position = ORACLE_STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
