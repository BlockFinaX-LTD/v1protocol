// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library LibAppStorage {
    bytes32 constant APP_STORAGE_POSITION = keccak256("blockfinax.app.storage");

    // ============================================================
    //                    HEDGE STORAGE STRUCTS
    // ============================================================

    enum HedgeEventStatus { Open, Settled, Expired }
    enum HedgePositionStatus { Active, SettledWin, SettledLoss, Claimed, Claimable, Expired }

    struct HedgeEvent {
        uint256 id;
        address creator;
        string name;
        string underlying;
        uint256 strike;
        uint256 premiumRate;
        uint256 expiryDate;
        HedgeEventStatus status;
        uint256 settlementPrice;
        bool triggered;
        uint256 settledAt;
        bool poolOpen;
        bool allowExternalLp;
        uint256 creatorEarnings;
        uint256 totalLiquidity;
        uint256 totalExposure;
        uint256 totalPremiums;
        uint256 lpCount;
        uint256 hedgerCount;
        uint256 createdAt;
        uint256 initialRate;
        uint256 totalMaxPayout;
        bool strikeAbove;
    }

    struct HedgePosition {
        uint256 id;
        uint256 eventId;
        address hedger;
        uint256 notional;
        uint256 premiumPaid;
        uint256 platformFeePaid;
        uint256 payoutAmount;
        HedgePositionStatus status;
        bool claimed;
        uint256 createdAt;
    }

    struct HedgeLpDeposit {
        uint256 id;
        uint256 eventId;
        address lp;
        uint256 amount;
        uint256 shares;
        uint256 premiumsEarned;
        uint256 premiumsClaimed;
        bool withdrawn;
        uint256 withdrawnAt;
        uint256 createdAt;
    }

    struct HedgeFeeConfig {
        uint256 eventCreationFee;
        uint256 hedgerFeeRate;
        uint256 hedgerPayoutFeeRate;
        uint256 lpProfitFeeRate;
        uint256 creatorLoyaltyRate;
    }

    struct AppStorage {
        address usdcToken;

        // ============================================================
        //                    HEDGE STORAGE
        // ============================================================
        mapping(uint256 => HedgeEvent) hedgeEvents;
        uint256 hedgeEventCounter;
        uint256 totalHedgeEvents;

        mapping(uint256 => HedgePosition) hedgePositions;
        uint256 hedgePositionCounter;

        mapping(uint256 => HedgeLpDeposit) hedgeLpDeposits;
        uint256 hedgeLpDepositCounter;

        mapping(uint256 => uint256[]) hedgeEventPositionIds;
        mapping(uint256 => uint256[]) hedgeEventDepositIds;
        mapping(address => uint256[]) hedgeCreatorEventIds;
        mapping(address => uint256[]) hedgerPositionIds;
        mapping(address => uint256[]) lpDepositIds;

        HedgeFeeConfig hedgeFeeConfig;

        uint256 hedgePlatformFeesCollected;

        address hedgeOracleAdmin;

        // ============================================================
        //                    SECURITY FLAGS
        // ============================================================

        /// @dev Reentrancy lock — set true while a state-changing function executes
        bool hedgeReentrancyLock;

        /// @dev Emergency pause — all hedger/LP state-changing functions blocked when true
        bool paused;

        /// @dev Set to true when initializeHedgeFees() is called; required before createEvent()
        bool feesInitialized;
    }

    function appStorage() internal pure returns (AppStorage storage s) {
        bytes32 position = APP_STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
