// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

/**
 * @title TestPureFacet
 * @notice Tiny pure-function facet used to exercise the Diamond cut machinery in tests.
 *         Has no storage, so no risk of clashing with AppStorage. Lives under src/mocks/
 *         so Hardhat compiles it; never deployed in production.
 */
contract TestPureFacet {
    function getMagicNumber() external pure returns (uint256) {
        return 42;
    }

    function getMagicString() external pure returns (string memory) {
        return "hello";
    }

    function echo(uint256 value) external pure returns (uint256) {
        return value;
    }
}

/**
 * @title TestPureFacetV2
 * @notice Replacement for TestPureFacet — `getMagicNumber()` now returns 100. Used to verify
 *         the Replace branch of LibDiamond.diamondCut() rewires the selector to a new facet.
 *         Intentionally only redefines `getMagicNumber()` so the test can confirm that other
 *         selectors on the original facet (`getMagicString`, `echo`) keep working.
 */
contract TestPureFacetV2 {
    function getMagicNumber() external pure returns (uint256) {
        return 100;
    }
}
