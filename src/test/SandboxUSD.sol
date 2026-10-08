// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Valueless partner test funds. Can only be deployed on test networks.
contract SandboxUSD is ERC20 {
    uint256 public constant FAUCET_AMOUNT = 10_000 * 1e6;
    mapping(address => uint256) public nextClaimAt;

    constructor() ERC20("BlockFinaX Sandbox USD", "sUSD") {
        require(block.chainid == 84532 || block.chainid == 31337, "Sandbox: testnet only");
    }

    function decimals() public pure override returns (uint8) { return 6; }

    /// @notice Claim 10,000 test dollars once per day, using your own wallet.
    function claim() external {
        require(block.timestamp >= nextClaimAt[msg.sender], "Sandbox: faucet cooldown");
        nextClaimAt[msg.sender] = block.timestamp + 1 days;
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
