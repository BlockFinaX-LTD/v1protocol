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

> **Remediation status (updated).** F-02 and F-11 were fixed and deployed to **Base**
> on the HedgeFacet upgrade cut `0x29251f78ef441a4df70c2cb7db69f256418f68953ba0d5a8ab0fcf44349cc62d`
> (new HedgeFacet `0x62be10C0642e9CF06656C113941a3D0180fC9850`). Verified on chain: the 19.2725
> USDC of stranded premiums is now claimable by the affected LPs, and `recoverExpiredPayouts`
> reverts "Not owner" for non-owners.
>
> The fee-model changes (F-09, F-10) were also deployed to **Base** — facet upgrade cut
> `0xae1e2611c7dbc45cc517b2154e33d64f5b43043da4189f3078e7de2d16c922e3` (new HedgeFacet
> `0xAf7f51795b2583a2ce73186A19090B51FA0f52C1`) plus `initializeHedgeFees` tx
> `0x8895dbd6810c1ee8602380b72f02ff73252af8b5f0feb1ecf73a40b8a7b85973`. Verified on chain:
> getHedgeFeeConfig = [25000000, 50000, 20000, 20000, 50000] = $25 / 5% of premium / 2% payout /
> 2% LP / 5% loyalty.
>
> **BSC is still pending on all of the above** — the deployer wallet is out of BNB gas; upgrade
> BSC after topping up. All other findings remain open.

| ID | Severity | Title | Layer |
|---|---|---|---|
| [F-01](#f-01) | **Critical** | Single EOA controls upgrades; no timelock, no multisig | Governance |
| [F-02](#f-02) | **High (FIXED on Base)** | `recoverExpiredPayouts` was permissionless and could destroy unclaimed hedger payouts | Contract |
| [F-03](#f-03) | **High** | LP capital can be stranded indefinitely if the oracle never settles | Contract / Liveness |
| [F-04](#f-04) | **High** | Settlement price authority concentrated in one key (same key as owner) | Governance |
| [F-05](#f-05) | **Medium** | `HedgeEventStatus.Expired` is never assigned → UI/chain state mismatch | Contract / Integration |
| [F-06](#f-06) | **High** | Frontend/API calls `recoverExpiredPayouts(eventId)` for LP capital recovery | Integration |
| [F-07](#f-07) | **Low** | No per-hedger concentration cap on pool capacity | Design |
| [F-08](#f-08) | **Info** | Orphaned facet addresses remain in `facetAddresses()` after upgrades | Cosmetic |
| [F-09](#f-09) | **Medium (FIXED on Base)** | Event creation fee was **$2**, now **$25** | Configuration |
| [F-10](#f-10) | **FIXED on Base** | Hedger platform fee rebased to **5% of premium** (was 0.5% of notional); payout & LP fees raised to 2% | Contract / Economics |
| [F-11](#f-11) | **High (FIXED on Base)** | LP premiums stranded permanently when capital is withdrawn before claiming (~19.27 USDC) | Contract |

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

**STATUS: FIXED on Base** (cut `0x29251f78…`). `recoverExpiredPayouts` is now `onlyOwner`.
Verified: a non-owner call reverts "Not owner". BSC pending gas top-up.

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

### <a id="f-09"></a>F-09 — Production event creation fee is $2, not the intended $25 (Medium)

**Observed on-chain.** `getHedgeFeeConfig()` returns `eventCreationFee`:

| Chain | Live value | Human | Intended |
|---|---|---|---|
| Base (USDC, 6 dec) | `2000000` | **$2** | **$25** → `25000000` |
| BSC (USDT, 18 dec) | `2000000000000000000` | **$2** | **$25** → `25000000000000000000` |

The Base deployment record (`deployments-diamond-base.json`) documents `25000000` ($25), but
`scripts/set-fee-new-diamonds.js` later set it to $2 on both chains. Production has drifted from
the intended fee schedule and is under-charging event creation by 12.5×.

**Impact.** Revenue loss only; no security consequence. Also weakens the creation fee's role as a
spam deterrent for event creation.

**Recommendation.** Restore $25 via `initializeHedgeFees(...)` (owner-only). This is a **pure
configuration change — no contract upgrade needed.** Mind the decimals per chain (USDC 6-dec vs
USDT 18-dec) and note the `$1000` cap in `initializeHedgeFees`. Existing events are unaffected:
fee rates are snapshotted per-event at `createEvent`, so changes apply only to **new** events.

---

### <a id="f-10"></a>F-10 — Hedger platform fee must be rebased from notional to premium (Planned change)

**Current behaviour.** `buyProtection` charges the platform fee as a fraction of **notional**:

```solidity
uint256 premium     = (_notional * evt.premiumRate) / PRECISION;
uint256 platformFee = (_notional * hedgerFeeRate)  / PRECISION;   // ← based on NOTIONAL
uint256 totalCost   = premium + platformFee;
```

**Intended behaviour.** Charge **2.5% of the premium**, not of notional:

```solidity
uint256 platformFee = (premium * hedgerFeeRate) / PRECISION;      // ← based on PREMIUM
// with hedgerFeeRate = 25_000  (2.5%)
```

Worked example (the target semantics): `notional = 100,000`, `premiumRate = 1%` → `premium = 1,000`.
The hedger pays `1,000 + 2.5% × 1,000 = 1,025`.

> ⚠️ **This is a code change, not a config change.** Setting `hedgerFeeRate = 25_000` alone would
> charge **2.5% of notional** (= 2,500 on the example above — worse than today). The fee *base* is
> hard-coded to `_notional` and must be changed to `premium` in `buyProtection`, then shipped as a
> facet upgrade.

**Why the change is directionally right.** Under the current formula the fee as a share of premium is
`hedgerFeeRate / premiumRate`. At today's production values (0.5% / 1%) the platform takes **50% of
the premium** — the hedger pays a 50% surcharge on top of their premium. Rebasing to 2.5% of premium
reduces that surcharge to 2.5%, which is far more defensible.

**Revenue impact — quantify before shipping.** New fee ÷ old fee = `5 × premiumRate`:

| `premiumRate` | Old fee (0.5% × notional) | New fee (2.5% × premium) | Change |
|---|---|---|---|
| 1% | 500 | 25 | **−95%** |
| 2.5% | 500 | 62.50 | −87.5% |
| 20% | 500 | 500 | break-even |

At a 1% premium rate this cuts hedger-fee revenue by ~95×/20×. Creator-loyalty earnings (5% of every
platform fee) scale down proportionally. This may well be intentional — but it should be a decision,
not a surprise.

**Deployment caveat (same class as the European settlement change).** `HedgeEvent` snapshots
`snapshotHedgerFeeRate` as a *rate*, not a formula. Changing the formula therefore **retroactively
reinterprets the snapshot** of any event that is still `Open` — their fee base would silently switch
from notional to premium mid-flight. Ship this only when there are **zero open events** (currently
true on both chains: 0 open), or gate the new formula behind a per-event flag.

**Work required.**
1. `BlockFinaXHedgeFacet.buyProtection` — change the fee base to `premium`.
2. Update NatSpec on `HedgeFeeConfig.hedgerFeeRate` ("Platform fee on notional" → "on premium") and
   the facet header comment describing the cost breakdown.
3. Set `hedgerFeeRate = 25_000` (2.5%) via `initializeHedgeFees`. The ≤10% cap already permits this.
4. Update tests that assert the old basis (`buyProtection.test.js` expects `platformFeePaid` =
   0.5% × notional; `bakerScenario`, `multiToken`, `feeAdminAndViews` encode the $5 / $29.75 figures).
5. Deploy via `npm run upgrade:hedge:base` / `:bsc` while no events are open, then verify
   `getHedgeFeeConfig()` on both chains.

Note `lpProfitFeeRate` is **already** premium-based (charged on the premium claim), so this change
makes the fee model internally consistent.

---

### <a id="f-11"></a>F-11 — LP premiums stranded on withdrawal-before-claim (High)

**STATUS: FIXED on Base** (cut `0x29251f78…`, new HedgeFacet `0x62be10C0…fC9850`).

**Observed on-chain.** The Base diamond held 52.30 USDC, of which ~19.27 was unattributable to
any claimable bucket. Tracing contract state showed it was exactly the sum of premiums paid in by
hedgers that no LP had ever claimed: total premiums paid in 19.4726, total ever claimed **0.0**,
still-claimable on the one open event 0.2, leaving **19.2726 USDC stranded**.

**Root cause.** The `H-01` guard in `claimPremiums` blocked *all* premium claims once an LP had
withdrawn capital (`require(!dep.withdrawn)`). Because `withdrawCapital` does not auto-pay premiums,
any LP who called `withdrawCapital` before `claimPremiums` permanently forfeited their premium
income, and — since no existing function can move the payment token out except the capped fee
withdrawal (which excludes it) and the USDC-blocked `rescueERC20` — the tokens became unrecoverable
without a code change. Every LP across every settled event hit this (claimed = 0).

Attribution: dep#1 (`0xCab3…e894`) 1.0; dep#3+#5 (`0x6084…2C83`) 9.6302; dep#6+#7 (`0x420e…1e98`)
8.6423.

**Why the guard was unnecessary.** `withdrawCapital` requires the event to be settled, and
`buyProtection` (the only thing that grows `accPremiumPerShare`) requires it to be Open. So once a
deposit is withdrawable its premium accumulator is permanently frozen; `rewardDebt` advances on each
claim, so a withdrawn LP can claim their frozen premium exactly once. The "claim indefinitely"
concern the guard was added for cannot occur.

**Fix.** Removed the `!dep.withdrawn` guard from `claimPremiums` (premiums are now claimable before
or after capital withdrawal) and updated `pendingPremiums` to report the recoverable amount for
withdrawn deposits. Verified on chain: simulated `claimPremiums` from each affected LP now succeeds,
totalling 19.2725 USDC recoverable.

**Recommended follow-up.** Frontend should surface pending premiums for withdrawn deposits and
prompt affected LPs to reclaim. Optionally, have `withdrawCapital` auto-pay pending premiums so it is
a single action (deferred; not required for correctness now that claims are always possible).

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
7. **F-09** — restore the $25 event creation fee on both chains *(config only, no upgrade)*.
8. **F-10** — rebase the hedger fee to 2.5% of premium *(code change; ship while 0 events are open,
   ideally batched with the F-02/F-03 contract fixes into a single facet upgrade)*.
9. **F-07 / F-08** — optional hardening and cleanup.

> **Batching note.** F-02 (access control), F-03 (`expireEvent`), and F-10 (fee rebase) are all
> `HedgeFacet` changes. Ship them as **one** facet upgrade rather than three, and do it while no
> events are open so no in-flight event's snapshot semantics change.

---

## 6. Note on the European settlement change

As of the upgrade recorded in `deployments/`, settlement is **expiry-only**: an event may be settled
only at or after `expiryDate`, in both `HedgeFacet.settleEvent` and `OracleFacet.submitRate`. A
strike touched mid-period but retraced by expiry does **not** pay out.

Preflight before the upgrade confirmed **zero open events with live positions** on either chain, so
no existing hedger's terms were altered retroactively. The principal *ongoing* consequence is
[F-03](#f-03): settlement can no longer occur early, so every event now depends on a timely oracle
call after expiry to release LP capital.
