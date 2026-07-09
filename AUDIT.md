# BlockFinaX v1 — Internal Security & Design Review

**Status:** Internal engineering review — *not* a substitute for a professional third-party audit.
**Scope:** `src/` (Diamond + facets + libraries), deployment/governance configuration, and the
live Base / BSC mainnet state.
**Method:** Full source read, 275-test suite (100% function coverage on production facets),
and direct read-only on-chain verification via RPC.
**On-chain observations taken at:** Base block time `2026-07-09T08:33 UTC`.

---

## 1. On-chain state at time of review (verified, not assumed)

| | Base (8453) | BSC (56) |
|---|---|---|
| Diamond | `0xbCC51E62C4948FD35ab505bd71804C849601e4Ef` | `0xaC939C0897981Abc0711ec4e37527F13106180fc` |
| HedgeFacet | `0x955a8326bdd3B675CdF7a82367B6d0B99A5d48Dd` | `0xB3900b754B3AE67bC1b0E13F7806A5D896636F90` |
| OracleFacet | `0xddA7254F0BB262a34088FE0D98Aec4f413571838` | `0xe5e1a1C5942dab29070A62e69310fdcBA6aA92D4` |
| **Owner** | `0xef5Bed7c221c85A2c88e3c0223ee45482d6F037d` (EOA) | same EOA |
| Owner == Safe? | **No** | **No** |
| Timelock installed? | **No** (`executeCut` → `address(0)`) | **No** |
| Gnosis Safe (deployed, **unwired**) | `0x7909a2f1fAd63678eEDcC5A75462B66D062189Bb` | `0x2a0ab363E01b518B189218e39f79Bfc3AE310807` |

> The Safes exist but **ownership was never transferred to them**, and the `BlockFinaXTimelockCutFacet`
> was **never cut into any Diamond**. Deployment records prove only that these contracts were
> *deployed*, not *wired in*. Upgrades today are instant, single-key, and unilateral.

---

## 2. Findings summary

| ID | Severity | Title | Layer |
|---|---|---|---|
| [F-01](#f-01) | **Critical** | Single EOA controls upgrades; no timelock, no multisig | Governance |
| [F-02](#f-02) | **High** | `recoverExpiredPayouts` is permissionless and can destroy unclaimed hedger payouts | Contract |
| [F-03](#f-03) | **High** | LP capital can be stranded indefinitely if the oracle never settles | Contract / Liveness |
| [F-04](#f-04) | **High** | Settlement price authority concentrated in one key (same key as owner) | Governance |
| [F-05](#f-05) | **Medium** | `HedgeEventStatus.Expired` is never assigned → UI/chain state mismatch | Contract / Integration |
| [F-06](#f-06) | **High** | Frontend/API calls `recoverExpiredPayouts(eventId)` for LP capital recovery | Integration |
| [F-07](#f-07) | **Low** | No per-hedger concentration cap on pool capacity | Design |
| [F-08](#f-08) | **Info** | Orphaned facet addresses remain in `facetAddresses()` after upgrades | Cosmetic |

---

## 3. Detailed findings

### <a id="f-01"></a>F-01 — Single EOA controls upgrades (Critical)

**Location:** Governance configuration (on-chain), not source.

The Diamond's `contractOwner` on both mainnets is a single externally-owned account,
`0xef5Bed7c…037d`. The timelock cut facet is not installed, so `diamondCut` executes
**immediately**. That one key can therefore:

1. `diamondCut` arbitrary logic into the Diamond in a single transaction, and
2. thereby bypass every application-layer safety bound — including the `withdrawPlatformFees`
   fee cap and the `rescueERC20` payment-token block — and drain **all** LP capital, premiums,
   and reserved payouts.

The application-layer guarantee that "the owner can only withdraw fees" is real, but it is only
as strong as the key controlling upgrades. Today that guarantee is worth exactly one private key.

**Recommendation.** Install the 48h timelock and transfer ownership to the 2-of-3 Safe:

```bash
npm run governance:install:base   # deploys timelock, cuts it in, transfers ownership to Safe
npm run governance:install:bsc
# Safe then finalises the two-step handover:
ACTION=acceptOwnership ... npx hardhat run scripts/safe-create-tx.js --network base
```

Verify afterwards with `scripts/check-ownership-direct.js`. Do this **before scaling TVL**.

---

### <a id="f-02"></a>F-02 — `recoverExpiredPayouts` is permissionless and destroys unclaimed hedger payouts (High)

**Location:** `src/facets/BlockFinaXHedgeFacet.sol` — `recoverExpiredPayouts(uint256)`

The function has **no access control** — any address may call it. Once an event is `Settled`,
`triggered`, and 90 days past `settledAt`, it walks every position that is still `Claimable`
and unclaimed, and:

- sets `pos.payoutAmount = 0`,
- flips `pos.status = Expired`,
- credits the residual to `platformFeesByToken` (i.e. the protocol's fee bucket).

Winning hedgers who have not yet claimed **permanently lose their payout**, and the money moves
to the platform. This is intentional as a fund-recovery escape hatch, but making it callable by
*anyone* means an unrelated party — or a mis-wired UI button (see [F-06](#f-06)) — can trigger
the confiscation on hedgers' behalf.

**Impact.** Loss of user funds (hedger payouts) triggered by a non-privileged caller.
Currently latent only because no event has both `triggered == true` and `settledAt + 90 days`
elapsed. This becomes live as the protocol ages.

**Recommendation.** Restrict to `onlyOwner` (or a dedicated keeper role). Consider also emitting
a per-position event so confiscations are auditable, and/or lengthening the grace period.

---

### <a id="f-03"></a>F-03 — LP capital can be stranded indefinitely (High)

**Location:** `withdrawCapital` gate + settlement paths.

```solidity
require(evt.status != HedgeEventStatus.Open, "Cannot withdraw while event is active");
```

LP capital unlocks **only** when an event leaves `Open`, and the *only* way that happens is an
oracle calling `settleEvent` (single-key) or reaching `submitRate` consensus. There is **no
permissionless fallback**.

This risk was materially **amplified** by the European (expiry-only) settlement change: previously
an event could settle early the moment the strike was touched (e.g. event #5 settled 2026-05-29
against a 2026-06-18 expiry). Now settlement is *impossible* before expiry, so **every event
necessarily passes through an "expired but unsettled" window** in which LP capital is frozen. If
the oracle key is lost, the oracle bot stalls, or `oracleV2Active` is enabled without a working
quorum, LP capital is locked **forever** with no recovery path.

Observed in production: event #7 expired at `08:02:57` and was not settled until `08:26:41` —
a 24-minute freeze. A dead oracle makes that permanent.

**Recommendation.** Add a permissionless escape hatch. The safest form:

```solidity
/// Anyone may close an expired event that has NO hedger positions.
/// With zero positions there is no settlement price to manipulate and no payout to compute.
function expireEvent(uint256 _eventId) external {
    require(evt.status == Open && block.timestamp >= evt.expiryDate);
    require(s.hedgeEventPositionIds[_eventId].length == 0);
    evt.status = Settled;                 // triggered = false, totalMaxPayout = 0
    evt.liquidityAtSettlement = evt.totalLiquidity;
    evt.settledAt = block.timestamp;
}
```

For events *with* positions, consider a long-dated (e.g. 180-day) fallback that settles at
`initialRate` (no trigger) so LP capital is never permanently lost.

---

### <a id="f-04"></a>F-04 — Settlement price authority is concentrated (High)

**Location:** `settleEvent` + `hedgeOracleAdmin`.

Per deployment records, `oracleAdmin` is `0xef5Bed7c…037d` — **the same key as the Diamond owner**.
Unless `activateOracleV2()` has been called (it has not, to our knowledge), the single-key
`settleEvent` path is live, and the submitted price is only sanity-bounded:

```solidity
require(price >= initialRate / 100 && price <= initialRate * 100, "…out of plausible range");
```

Within that 100× band the oracle admin **chooses** whether hedgers get paid, and how much. One key
therefore controls upgrades, fee withdrawal, **and** settlement outcomes.

**Recommendation.** At minimum, separate the `oracleAdmin` key from the owner key. Preferably
register ≥3 oracles, verify consensus works, then call `activateOracleV2()` to permanently disable
the single-key path. Note this is one-way and irreversible — test the quorum thoroughly first, and
note the interaction with [F-03](#f-03) (a broken quorum after activation strands capital).

---

### <a id="f-05"></a>F-05 — `HedgeEventStatus.Expired` is never assigned (Medium)

**Location:** `src/libraries/LibAppStorage.sol`

```solidity
enum HedgeEventStatus { Open, Settled, Expired }
// Expired: "Reserved for future use; events currently transition Open → Settled only.
//           Never assigned by current code."
```

An event past its `expiryDate` but not yet settled remains `Open (0)` on-chain. Consumers that
derive "Expired" from `expiryDate < now` therefore disagree with the contract, and any action
gated on `status != Open` (notably `withdrawCapital`) reverts while the UI claims the event has
ended. This directly produced the production confusion documented in [F-06](#f-06).

**Recommendation.** Either assign `Expired` in an `expireEvent` path (see [F-03](#f-03)), or remove
the value and document that `Open` + `now > expiryDate` means **"awaiting settlement."** Consumers
must render that state distinctly — not as a terminal "Expired."

---

### <a id="f-06"></a>F-06 — Frontend/API calls the wrong function for LP capital recovery (High, integration)

**Observed in production.** The "recover capital" action submits a UserOperation whose inner
calldata is:

```
0xd06be38e 0000…0007      →  recoverExpiredPayouts(uint256 eventId = 7)
```

which reverted with `Event not settled` (`0x08c379a0…4576656e74206e6f7420736574746c6564`).

Two defects:

1. **Wrong function.** `recoverExpiredPayouts` is protocol maintenance that sweeps unclaimed
   *hedger payouts* into *platform fees*. It never returns capital to an LP. The correct call is
   **`withdrawCapital(uint256 depositId)`** (selector `0xd95b0a12`).
2. **Wrong identifier.** It passes `eventId` (7); the LP function takes a `depositId` (9 for this LP).

**Danger.** Because [F-02](#f-02) makes `recoverExpiredPayouts` permissionless, this button will
eventually **succeed** — on a `triggered` event 90+ days past settlement — and confiscate every
unclaimed hedger's payout into platform fees. A user pressing "recover capital" would silently
destroy other users' funds.

**Verification (read-only simulation from the LP's smart account `0x6084…2C83`):**

| Call | Result |
|---|---|
| `recoverExpiredPayouts(7)` | revert `Event did not trigger: no payouts reserved` |
| `withdrawCapital(9)` | revert `Already withdrawn` *(capital was recovered)* |
| `withdrawCapital(7)` | revert `Not your deposit` |

**Recommendation.** Resolve the deposit id, then call the correct function:

```ts
const ids = await diamond.getLpDepositIds(lp);
const target = /* first id where eventId matches, lp matches, !withdrawn */;
await diamond.withdrawCapital(target);           // 0xd95b0a12
```

Correct user-action mapping:

| Action | Function | Argument |
|---|---|---|
| LP recover capital | `withdrawCapital` | **depositId** |
| LP claim premiums | `claimPremiums` | **depositId** |
| Hedger claim payout | `claimPayout` | **positionId** |
| Sweep stale payouts | `recoverExpiredPayouts` | eventId — **admin/keeper only, never a user button** |

---

### <a id="f-07"></a>F-07 — No per-hedger concentration cap (Low)

`buyProtection` bounds a purchase only by pool-wide free liquidity:

```solidity
require(predeterminedPayout <= evt.totalLiquidity - evt.totalMaxPayout, "Insufficient pool liquidity for payout");
```

A single hedger may therefore consume 100% of a pool's capacity. **This is not a solvency issue** —
the position remains fully collateralised — but it permits capacity monopolisation and concentrates
LP risk in one counterparty.

**Recommendation.** If desired, add an optional per-position or per-hedger notional cap (e.g. a
percentage of `totalLiquidity`). The solvency invariant does not require it.

---

### <a id="f-08"></a>F-08 — Orphaned facet addresses in the Loupe (Informational)

After a `Replace`-based upgrade, the superseded facet addresses remain in `facetAddresses()` with
zero selectors (Base reports 11 facets, BSC 12). Purely cosmetic — selector routing is correct and
was verified post-upgrade. `scripts/remove-orphans-v8.js` cleans this up.

---

## 4. Verified correct (no action required)

These were examined closely and found sound:

- **Solvency invariant.** `buyProtection` reserves the *worst-case* payout
  (`notional × rangeWidth / initialRate`) and requires `Σ(worst-case) ≤ totalLiquidity`. At
  settlement `effectiveMove ≤ maxPriceMove`, so **actual payout ≤ reserved payout, always**.
  Integer truncation rounds in the pool's favour. Collateral is locked while the event is `Open`.
  Premiums and fees are excluded from payout backing and sit as an additional buffer.
  The `bakerScenario` e2e test asserts conservation of value end-to-end.
- **Premium liquidity.** `claimPremiums` has no settlement gate — LPs may withdraw premium income
  immediately, mid-event, without weakening collateral (premiums are accounted separately from
  `totalLiquidity`).
- **Storage safety.** Three isolated Diamond storage slots; struct fields strictly appended
  (`v2 … v8`); the European change altered no layout.
- **Reentrancy & CEI.** Shared `hedgeReentrancyLock` across facets; external transfers always last.
- **Accounting integrity.** `tokenReserves` used in place of `balanceOf` (donation-attack safe);
  `rescueERC20` blocks the payment token and all whitelisted payment tokens (anti-rug);
  fee withdrawal bounded by the fee counters.
- **DoS bounds.** 500 positions and 200 deposits per event; 10 oracles; all loops bounded.
- **Upgrade correctness.** Post-upgrade routing verified: `settleEvent` → new HedgeFacet,
  `submitRate` → new OracleFacet, both listed in `facetAddresses()` on both chains.
- **Test coverage.** 275 tests passing; 100% function coverage on every production facet
  (~98% statements). Remaining uncovered branches are defensive guards.

---

## 5. Recommended remediation order

1. **F-01** — wire the Safe + 48h timelock. Removes the upgrade-and-drain risk. *(scripts ready)*
2. **F-06** — fix the frontend to call `withdrawCapital(depositId)`. Stops user-triggered fund loss.
3. **F-02** — gate `recoverExpiredPayouts` behind `onlyOwner`/keeper. Defence in depth for F-06.
4. **F-03** — add a permissionless `expireEvent` escape hatch for zero-position events, plus a
   long-dated LP recovery fallback. Removes the stranded-capital risk introduced by European settlement.
5. **F-04** — split the oracle key from the owner key; move toward `activateOracleV2()` consensus.
6. **F-05** — render `Open && now > expiryDate` as **"Awaiting settlement"** in all consumers.
7. **F-07 / F-08** — optional hardening and cleanup.

---

## 6. Note on the European settlement change

As of the upgrade recorded in `deployments/`, settlement is **expiry-only**: an event may be settled
only at or after `expiryDate`, in both `HedgeFacet.settleEvent` and `OracleFacet.submitRate`. A
strike touched mid-period but retraced by expiry does **not** pay out.

Preflight before the upgrade confirmed **zero open events with live positions** on either chain, so
no existing hedger's terms were altered retroactively. The principal *ongoing* consequence is
[F-03](#f-03): settlement can no longer occur early, so every event now depends on a timely oracle
call after expiry to release LP capital.
