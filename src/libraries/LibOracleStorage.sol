// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LibOracleStorage
 * @notice Isolated storage for the multi-signer OracleFacet.
 *         Uses a separate storage slot from AppStorage so it never
 *         collides with the existing HedgeFacet state.
 *
 * Deploy path: BlockFinaXOracleFacet (new) reads this library.
 *              No existing facets are modified.
 */
library LibOracleStorage {
    bytes32 constant ORACLE_STORAGE_POSITION =
        keccak256("blockfinax.oracle.v2.storage");

    struct Submission {
        uint256 price;
        uint256 timestamp;
        bool exists;
    }

    struct OracleStorage {
        address[] oracles;
        mapping(address => bool) isOracle;

        uint256 requiredSigners;
        uint256 toleranceBps;

        mapping(uint256 => mapping(address => Submission)) submissions;
        mapping(uint256 => address[]) submitters;
    }

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
