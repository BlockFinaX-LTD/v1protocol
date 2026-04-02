// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import {IDiamondCut} from "../interfaces/IDiamondCut.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

/**
 * @title  BlockFinaXTimelockCutFacet
 * @notice Replaces the standard DiamondCutFacet with a timelocked version.
 *         Any upgrade must be proposed first, then executed after TIMELOCK_DELAY.
 *         Only the Diamond owner can propose, execute, or cancel.
 *
 * Flow:
 *   1. Owner calls diamondCut(...)  →  proposal stored, CutProposed emitted
 *   2. Wait 48 hours
 *   3. Owner calls executeCut(proposalId)  →  upgrade applied
 *
 * Emergency: Owner can call cancelCut(proposalId) at any time before execution.
 *
 * Security fixes applied:
 *   M-04: proposalId includes a nonce counter to prevent collision when the same
 *         cut payload is proposed in the same block (timestamp + blocknumber
 *         alone are not unique within a block's call sequence).
 */
contract BlockFinaXTimelockCutFacet {
    uint256 public constant TIMELOCK_DELAY = 48 hours;
    uint256 public constant MAX_PROPOSAL_AGE = 30 days;

    bytes32 private constant STORAGE_SLOT =
        keccak256("blockfinax.timelock.cut.storage.v1");

    struct StoredFacetCut {
        address facetAddress;
        IDiamondCut.FacetCutAction action;
        bytes4[] functionSelectors;
    }

    struct Proposal {
        StoredFacetCut[] facetCuts;
        address init;
        bytes callData;
        uint256 eta;
        bool executed;
        bool cancelled;
    }

    struct TimelockStorage {
        mapping(bytes32 => Proposal) proposals;
        bytes32[] ids;
        // M-04 fix: monotonic nonce ensures proposalId is unique even when the same
        // facetCuts/init/callData tuple is submitted twice in the same block.
        uint256 nonce;
    }

    event CutProposed(bytes32 indexed proposalId, uint256 eta);
    event CutExecuted(bytes32 indexed proposalId);
    event CutCancelled(bytes32 indexed proposalId);

    function _store() private pure returns (TimelockStorage storage ts) {
        bytes32 slot = STORAGE_SLOT;
        assembly { ts.slot := slot }
    }

    /**
     * @notice Propose a Diamond upgrade. Replaces immediate execution.
     *         The same function signature as the original diamondCut so the
     *         selector is identical — this facet simply replaces the old one.
     *
     * @dev M-04 fix: the nonce is incremented before hashing so that two identical
     *      proposals submitted in the same block produce distinct proposalIds and
     *      both can be queued independently.
     */
    function diamondCut(
        IDiamondCut.FacetCut[] calldata _facetCuts,
        address _init,
        bytes calldata _callData
    ) external {
        LibDiamond.enforceIsContractOwner();

        TimelockStorage storage ts = _store();
        // M-04 fix: include incrementing nonce in hash to guarantee uniqueness.
        bytes32 proposalId = keccak256(
            abi.encode(_facetCuts, _init, _callData, block.timestamp, block.number, ++ts.nonce)
        );
        uint256 eta = block.timestamp + TIMELOCK_DELAY;

        require(ts.proposals[proposalId].eta == 0, "Proposal ID collision: try again");

        // M-2 fix: validate that Add/Replace facets are deployed contracts (have bytecode).
        // Proposing a cut that points to an EOA or zero address would pass the timelock delay
        // and then revert at execution time — wasting 48 hours and requiring a re-proposal.
        // Catching this at proposal time is both cheaper and safer.
        for (uint256 k; k < _facetCuts.length; k++) {
            IDiamondCut.FacetCutAction action = _facetCuts[k].action;
            if (action == IDiamondCut.FacetCutAction.Add || action == IDiamondCut.FacetCutAction.Replace) {
                address fa = _facetCuts[k].facetAddress;
                require(fa != address(0), "Facet address is zero");
                uint256 codeSize;
                assembly { codeSize := extcodesize(fa) }
                require(codeSize > 0, "Facet address has no code (not a contract)");
            }
        }

        Proposal storage p = ts.proposals[proposalId];
        for (uint256 i; i < _facetCuts.length; i++) {
            StoredFacetCut storage sfc = p.facetCuts.push();
            sfc.facetAddress = _facetCuts[i].facetAddress;
            sfc.action       = _facetCuts[i].action;
            for (uint256 j; j < _facetCuts[i].functionSelectors.length; j++) {
                sfc.functionSelectors.push(_facetCuts[i].functionSelectors[j]);
            }
        }
        p.init     = _init;
        p.callData = _callData;
        p.eta      = eta;
        ts.ids.push(proposalId);

        emit CutProposed(proposalId, eta);
    }

    /**
     * @notice Execute a previously proposed upgrade after the 48-hour delay.
     * @dev Function name matches the admin panel ABI ("executeCut").
     */
    function executeCut(bytes32 _proposalId) external {
        LibDiamond.enforceIsContractOwner();
        TimelockStorage storage ts = _store();
        Proposal storage p = ts.proposals[_proposalId];

        require(p.eta > 0,                "Unknown proposal");
        require(!p.executed,              "Already executed");
        require(!p.cancelled,             "Proposal cancelled");
        require(block.timestamp >= p.eta, "Timelock delay not elapsed");
        require(block.timestamp <= p.eta + MAX_PROPOSAL_AGE, "Proposal expired: re-propose");

        p.executed = true;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](p.facetCuts.length);
        for (uint256 i; i < p.facetCuts.length; i++) {
            cuts[i] = IDiamondCut.FacetCut({
                facetAddress:      p.facetCuts[i].facetAddress,
                action:            p.facetCuts[i].action,
                functionSelectors: p.facetCuts[i].functionSelectors
            });
        }
        LibDiamond.diamondCut(cuts, p.init, p.callData);

        emit CutExecuted(_proposalId);
    }

    /**
     * @notice Cancel a pending upgrade before it is executed.
     * @dev Function name matches the admin panel ABI ("cancelCut").
     */
    function cancelCut(bytes32 _proposalId) external {
        LibDiamond.enforceIsContractOwner();
        TimelockStorage storage ts = _store();
        Proposal storage p = ts.proposals[_proposalId];

        require(p.eta > 0,    "Unknown proposal");
        require(!p.executed,  "Already executed");
        require(!p.cancelled, "Already cancelled");

        p.cancelled = true;
        emit CutCancelled(_proposalId);
    }

    /**
     * @notice Return details of a specific proposal. Matches the admin panel ABI.
     * @param _proposalId The proposal to query.
     * @return status       0 = pending, 1 = cancelled, 2 = executed.
     * @return executeAfter Unix timestamp after which executeCut() can be called.
     * @return initAddress  Initialiser contract address (address(0) if none).
     * @return initCalldata Calldata to pass to the initialiser.
     */
    function getProposal(bytes32 _proposalId)
        external
        view
        returns (
            uint8 status,
            uint256 executeAfter,
            address initAddress,
            bytes memory initCalldata
        )
    {
        Proposal storage p = _store().proposals[_proposalId];
        if (p.executed)        status = 2;
        else if (p.cancelled)  status = 1;
        else                   status = 0;
        return (status, p.eta, p.init, p.callData);
    }

    /**
     * @notice Return all proposal IDs ever created (includes executed and cancelled).
     */
    function getAllCutIds() external view returns (bytes32[] memory) {
        return _store().ids;
    }

    /**
     * @notice Return all proposal IDs ever created.
     * @dev Kept for backwards compatibility. Prefer getAllCutIds().
     */
    function getPendingCutIds() external view returns (bytes32[] memory) {
        return _store().ids;
    }

    /**
     * @notice Return ETA and status for a proposal.
     * @dev Kept for backwards compatibility. Prefer getProposal().
     */
    function getPendingCutInfo(bytes32 _proposalId)
        external
        view
        returns (uint256 eta, bool executed, bool cancelled)
    {
        Proposal storage p = _store().proposals[_proposalId];
        return (p.eta, p.executed, p.cancelled);
    }
}
