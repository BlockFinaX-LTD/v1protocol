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
        string underlying;       // e.g. "USD/GHS"
        uint256 strike;          // Strike price (6 decimals, e.g. 16500000 = 16.5)
        uint256 premiumRate;     // Premium rate (6 decimals, e.g. 25000 = 2.5%)
        uint256 expiryDate;      // Unix timestamp
        HedgeEventStatus status;
        uint256 settlementPrice; // Actual FX rate at settlement (6 decimals)
        bool triggered;          // Did rate >= strike?
        uint256 settledAt;
        bool poolOpen;           // Can hedgers buy protection?
        bool allowExternalLp;    // Can non-creators deposit liquidity?
        uint256 creatorEarnings; // 5% of platform fees (USDC, 6 decimals)
        uint256 totalLiquidity;  // Total USDC deposited by LPs
        uint256 totalExposure;   // Sum of active position notionals (capacity reserved)
        uint256 totalPremiums;   // All premiums collected
        uint256 lpCount;         // Number of active LP deposits
        uint256 hedgerCount;     // Number of active hedge positions
        uint256 createdAt;
        uint256 initialRate;     // FX rate at event creation (6 decimals) — used to calculate predetermined payout
        uint256 totalMaxPayout;  // Sum of all position predetermined payouts (reserved from pool)
        bool strikeAbove;        // true = hedger wins when price rises to strike; false = hedger wins when price falls to strike
    }

    struct HedgePosition {
        uint256 id;
        uint256 eventId;
        address hedger;
        uint256 notional;        // Coverage amount (USDC, 6 decimals)
        uint256 premiumPaid;     // Premium paid to LPs (USDC, 6 decimals)
        uint256 platformFeePaid; // 0.5% fee paid to platform (USDC, 6 decimals)
        uint256 payoutAmount;    // Calculated at settlement (USDC, 6 decimals)
        HedgePositionStatus status;
        bool claimed;
        uint256 createdAt;
    }

    struct HedgeLpDeposit {
        uint256 id;
        uint256 eventId;
        address lp;
        uint256 amount;          // USDC deposited (6 decimals)
        uint256 shares;          // Pool share units (18 decimals for precision)
        uint256 premiumsEarned;  // Running total earned (USDC, 6 decimals)
        uint256 premiumsClaimed; // Already claimed (USDC, 6 decimals)
        bool withdrawn;          // Has LP taken capital back?
        uint256 withdrawnAt;
        uint256 createdAt;
    }

    struct HedgeFeeConfig {
        uint256 eventCreationFee;    // Flat fee to create event (USDC, 6 decimals) — default 25e6
        uint256 hedgerFeeRate;       // % of notional charged to hedger (6 decimals) — 5000 = 0.5%
        uint256 hedgerPayoutFeeRate; // % of payout deducted on claim (6 decimals) — 10000 = 1%
        uint256 lpProfitFeeRate;     // % of LP premium claim deducted (6 decimals) — 10000 = 1%
        uint256 creatorLoyaltyRate;  // % of platform fees to creator (6 decimals) — 50000 = 5%
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
    }

    function appStorage() internal pure returns (AppStorage storage s) {
        bytes32 position = APP_STORAGE_POSITION;
        assembly {
            s.slot := position
        }
    }
}
