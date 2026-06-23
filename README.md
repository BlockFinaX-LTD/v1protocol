# BlockFinaX v1 protocol

Smart contracts for **BlockFinaX**, an on-chain marketplace for hedging foreign-exchange risk in
emerging markets. People exposed to a weakening local currency buy **parametric FX protection**
that pays out automatically based on an oracle-reported rate; **liquidity providers (LPs)**
underwrite that risk in exchange for premiums. The protocol itself takes no market position — it
earns fees.

The on-chain core is an [EIP-2535](https://eips.ethereum.org/EIPS/eip-2535) **Diamond** with hedge,
oracle, governance, and introspection facets. The consuming app (frontend + backend + pricing
engine) lives in a separate repo:
[BlockFinaX-LTD/BlockFinaXcode](https://github.com/BlockFinaX-LTD/BlockFinaXcode).

---

## 1. What the protocol does

- A **creator** opens a *hedge event* for a currency pair (e.g. `USD/GHS`), defining a payout
  range, premium, expiry, and direction, and seeds initial liquidity.
- **LPs** add USDC/USDT liquidity and receive proportional shares; they collect premiums and
  back payouts.
- **Hedgers** buy protection: they pay a premium (distributed to LPs) plus a platform fee. Their
  worst-case payout is reserved from pool liquidity so the pool is always solvent.
- At **expiry**, an oracle posts the settlement rate; winning hedgers claim payouts, LPs reclaim
  capital (net of any loss), everyone settles up.

### Payout shape — range product (call/put spread)

Each event defines a payout **range** rather than a single trigger:

- `strike` — where payout begins.
- `payoutCap` — where payout is capped.
- Payout scales linearly between them: `notional × effectiveMove / initialRate`, capped at the
  far edge. Range width is capped at **10× notional** so one event can't drain a pool.
- `payoutCap == 0` selects the legacy **single-strike (digital)** mode — full fixed payout if the
  strike is touched. (Retained for compatibility; new events use the range product.)

### Settlement is European (expiry-only)

**An event can only be settled at or after its expiry date — even if the strike was already
touched.** The trigger is judged on the rate posted at/after expiry: a strike touched mid-period
but retraced by expiry does **not** pay out. This is enforced in both settlement paths
(`HedgeFacet.settleEvent` and `OracleFacet.submitRate`).

---

## 2. Architecture

A Diamond proxy holds all state and `delegatecall`s into facets. The proxy address never changes;
upgrades swap facet code behind it.

| Facet | Responsibility |
|---|---|
| `BlockFinaXHedgeFacet` | Full hedge lifecycle, fees, admin, single-key settlement |
| `BlockFinaXOracleFacet` | Multi-signer oracle consensus settlement |
| `BlockFinaXTimelockCutFacet` | Governance: 48h-timelocked upgrades (optional, see §8) |
| `BlockFinaXDiamondCutFacet` | Immediate (non-timelocked) upgrade entrypoint |
| `BlockFinaXDiamondLoupeFacet` | Introspection (`facets()`, `facetAddress()`, …) |
| `BlockFinaXOwnershipFacet` | Standalone owner views (not installed by default) |

**Storage** uses three isolated EIP-2535 slots to guarantee no collision:
`LibAppStorage` (hedge state), `LibOracleStorage` (oracle state), `LibDiamond` (routing + owner).
New struct fields are **always appended** — never reorder, or you corrupt live deployments.

---

## 3. Lifecycle

```
initializeHedgeFees (owner, once)
        │
createEvent ──► setPoolSettings ──► deposit (LPs) ──► buyProtection (hedgers)
        │                                                     │
        └────────────── (at/after expiry) settleEvent / oracle consensus
                                                              │
        claimPayout (hedgers) · claimPremiums (LPs) · withdrawCapital (LPs)
                                                  · withdrawCreatorEarnings (creator)
```

---

## 4. Fees / business model

All rates use `PRECISION = 1e6` (`5000 = 0.5%`). Five streams:

| Fee | Charged at | Recipient |
|---|---|---|
| Event creation fee (flat) | `createEvent` | Platform |
| Hedger fee (% notional) | `buyProtection` | Platform − creator loyalty |
| Hedger payout fee (% gross payout) | `claimPayout` | Platform − creator loyalty |
| LP profit fee (% premium claim) | `claimPremiums` | Platform − creator loyalty |
| Creator loyalty (% of every platform fee) | all of the above | Event creator |

Fee rates are **snapshotted onto each event at creation**, so changing the global config never
retroactively affects in-flight events. Defaults in production: hedger 0.5%, payout 1%, LP 1%,
creator loyalty 5%; creation fee $25 (Base) / $2 (BSC).

---

## 5. Networks & deployments

Active addresses live in `deployments/`. The Diamond is deployed on:

- **Base mainnet** (chainId 8453) — Diamond `0xbCC51E62C4948FD35ab505bd71804C849601e4Ef`, USDC
- **BNB Smart Chain mainnet** (chainId 56) — Diamond `0xaC939C0897981Abc0711ec4e37527F13106180fc`, USDT
- **Base Sepolia** (84532) and **BSC testnet** (97) for testing

---

## 6. Getting started

```bash
npm install
cp .env.example .env     # fill DEPLOYER_PRIVATE_KEY, *_DIAMOND_ADDRESS, RPCs, ETHERSCAN_API_KEY
npm run compile
npm test                 # full Hardhat suite (unit + integration + e2e)
```

Tests cover every facet (100% function coverage on the production facets). The fixture deploys a
full Diamond, funds wallets, and exposes helpers in `test/helpers/`.

---

## 7. Owner / admin operations

All owner functions are `onlyOwner` (the Diamond's `contractOwner`).

### Withdraw protocol fees (how the owner takes profit)

Fees accrue inside the Diamond, tracked per token. Read what's available, then withdraw up to it:

```solidity
getHedgePlatformFees()                       // USDC fees (legacy counter)
getPlatformFeesByToken(token)                // fees for any payment token

withdrawPlatformFees(amount)                 // owner → USDC (legacy path)
withdrawPlatformFeesByToken(token, amount)   // owner → any token (USDT etc.) — required for non-USDC
```

Both are `onlyOwner` + `nonReentrant`, CEI-ordered, and **bounded by the fee counters** — the owner
can withdraw *fees only*, never LP capital, premiums, or reserved payouts. `rescueERC20` explicitly
**blocks the payment token** (anti-rug); it can only sweep stray non-payment tokens. `rescueETH`
sweeps stranded ETH.

> ⚠️ This "fees only" bound holds at the application layer. At the governance layer, whoever owns
> the Diamond can upgrade it (`diamondCut`) to arbitrary logic and drain everything — see §8/§9.

### Other critical owner functions

| Function | Purpose |
|---|---|
| `initializeHedgeFees(...)` | Set/update the five fee rates (capped: ≤10% each, ≤50% loyalty). Required once before any event. |
| `pause()` / `unpause()` | Emergency stop for create/deposit/buy. Claims, withdrawals, and settlement keep working. |
| `setOracleAdmin(addr)` | Set the single-key settlement signer. |
| `activateOracleV2()` | One-way: permanently disable single-key settlement, require oracle consensus. |
| `setPricingEngineSigner(addr)` | Set/rotate the off-chain pricing-engine signer. Zero address = advisory mode. |
| `setAllowedPaymentToken(token, bool)` | Whitelist a stablecoin (e.g. USDT) for new events. |
| `recoverExpiredPayouts(eventId)` | **Permissionless.** Sweep unclaimed payouts into platform fees after the 90-day grace. |
| `transferOwnership` / `acceptOwnership` | Two-step ownership handover. |

### Oracle administration (`BlockFinaXOracleFacet`)

`addOracle` / `removeOracle` (max 10), `setRequiredSigners` (≥2), `setToleranceBps` (≤10%),
`clearStaleSubmissions`. Registered oracles call `submitRate(eventId, price)`; consensus
(enough agreeing, in-tolerance, non-stale submissions) auto-settles in the same tx.

---

## 8. Upgrading the contracts

The Diamond proxy address and storage are preserved across upgrades. An upgrade = deploy a new
facet, then re-point selectors at it via `diamondCut` (Replace existing selectors, Add new ones).
No ABI change is needed unless a function signature changes.

### Current process (immediate — single owner key)

> The live diamonds are currently owned by a **single EOA** with **no timelock** (verified
> on-chain). Upgrades apply instantly:

```bash
# Hedge + Oracle facets (deploys new facets, Replaces selectors, smoke-tests)
npm run upgrade:hedge:base
npm run upgrade:hedge:bsc

# Other targeted upgrades
npx hardhat run scripts/upgrade-oracle-facet.js --network base
npx hardhat run scripts/upgrade-cut-facet.js   --network base   # ship the LibDiamond facetAddresses fix
```

After any cut, verify the Loupe lists the new facet (`facetAddresses()`); if a Replace into a
brand-new facet didn't register it, run `scripts/rebuild-facet-table.js`.

### Hardened process (after wiring Safe + timelock — recommended)

Once governance is wired (§9), `diamondCut` routes through the 48h timelock and the owner is the
Safe. Every upgrade becomes:

1. **Propose** — Safe calls `diamondCut(cuts, init, data)` → stores a proposal, starts the 48h clock.
2. **Wait 48h** (proposal expires after 30 days if not executed).
3. **Execute** — Safe calls `executeCut(proposalId)`.

   Emergency abort before execution: `cancelCut(proposalId)`.

---

## 9. Governance & security model

### Current state (verified on-chain)

- Both mainnet diamonds are owned by the **deployer EOA** `0xef5Bed7c221c85A2c88e3c0223ee45482d6F037d`.
- The **timelock facet is not installed**; `diamondCut` is immediate.
- The Gnosis **Safes are deployed but ownership was never transferred to them**
  (Base `0x7909…`, BSC `0x2a0a…`, 2-of-3).

**Implication:** one key controls all upgrades and single-key settlement. It can withdraw fees
normally and could drain user funds via a malicious upgrade. Harden before scaling TVL.

### Wiring multisig + timelock (do this when ready)

Run as the current owner, **per chain** (order matters — install the timelock *before* transferring
ownership):

```bash
# 1. Install the 48h timelock and hand ownership to the Safe (one script)
npm run governance:install:base
npm run governance:install:bsc

# 2. The Safe finalises the two-step handover (script prints the exact command)
ACTION=acceptOwnership DIAMOND_ADDRESS=0x... SAFE_ADDRESS=0x... \
  npx hardhat run scripts/safe-create-tx.js --network base
```

To change only the owner (without installing the timelock):

```bash
npm run transfer-ownership:base        # defaults to the chain's Safe; or NEW_OWNER=0x...
```

Verify owner + timelock routing any time:

```bash
node scripts/check-ownership-direct.js   # reads contractOwner from storage on each chain
```

### Fund custody & safety guarantees (application layer)

- All funds pool inside the Diamond, denominated per event's payment token, tracked by internal
  counters (`tokenReserves`, `platformFeesByToken`, per-deposit shares) — not `balanceOf` (donation-attack safe).
- Reentrancy guard shared across facets; strict Check-Effects-Interactions (transfers last).
- Solvency: worst-case payouts reserved at buy time; LP loss share computed against a settlement
  snapshot so withdrawal order doesn't matter; unclaimed payouts swept only after a 90-day grace.
- Loop bounds: 500 positions / 200 deposits per event, 10 oracles.

---

## 10. Scripts reference

| Script / npm alias | Purpose |
|---|---|
| `npm run deploy:testnet` / `:mainnet` | Deploy a fresh Diamond (Base Sepolia / Base) |
| `npm run upgrade:hedge:base` / `:bsc` | Upgrade Hedge + Oracle facets |
| `scripts/upgrade-cut-facet.js` | Replace the cut facet (ship LibDiamond fix) |
| `scripts/deploy-oracle-facet.js` / `register-oracles.js` | Deploy/register oracle facet + wallets |
| `npm run set-pricing-signer` | Set the pricing-engine signer |
| `scripts/set-creation-fee.js` / `set-fee-new-diamonds.js` | Adjust fees |
| `npm run transfer-ownership:base` / `:bsc` | Change the Diamond owner |
| `npm run governance:install:base` / `:bsc` | Install timelock + transfer ownership to the Safe |
| `scripts/check-ownership-direct.js` | Read on-chain owner per chain |
| `scripts/rebuild-facet-table.js` | Repair Loupe `facetAddresses()` after a Replace |
| `scripts/safe-create-tx.js` / `deploy-safe-multichain.js` | Safe transaction helpers / deploy a Safe |

`scripts/_archive/` holds historical one-off migration scripts.

---

## 11. Repo layout

```
src/
  Diamond.sol            EIP-2535 Diamond proxy/router
  facets/                Hedge, Oracle, TimelockCut, DiamondCut, Loupe, Ownership
  interfaces/            IDiamondCut, IDiamondLoupe
  libraries/             LibAppStorage, LibOracleStorage, LibDiamond
  mocks/ test/           test-only mocks (ERC20, oracle stubs)
test/                    Hardhat tests — unit / integration / e2e + helpers
scripts/                 deploy + upgrade + governance + admin scripts
deployments/             deployed addresses by network
hardhat.config.js        Hardhat config (Base, BSC)
```

## 12. How the app integrates

The off-chain side reads the Diamond via plain `ethers.Contract` calls with hand-maintained ABI
fragments — there is no shared package. If you change a facet's external interface, update the
matching ABI fragment in the [app repo](https://github.com/BlockFinaX-LTD/BlockFinaXcode)
(under `server/`).

## License

MIT
