// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import { LibDiamond } from "../libraries/LibDiamond.sol";

contract BlockFinaXOwnershipFacet {
    function owner() external view returns (address) {
        return LibDiamond.contractOwner();
    }

    function pendingOwner() external view returns (address) {
        return LibDiamond.pendingOwner();
    }

    function transferOwnership(address _newOwner) external {
        LibDiamond.enforceIsContractOwner();
        LibDiamond.transferOwnership(_newOwner);
    }

    function acceptOwnership() external {
        LibDiamond.acceptOwnership();
    }
}
