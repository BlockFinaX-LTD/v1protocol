# Integration changes for backend & frontend

Audience: the app team (frontend, backend, pricing/oracle services) consuming the BlockFinaX
Diamond. This documents everything that changed on chain in this round of upgrades and exactly
what you need to update.

Status: **all changes are LIVE on Base. BSC is not yet updated** (deployer out of gas) — do not
assume BSC behaves the same until its upgrade lands.

---

## 0. TL;DR — the one thing that could break users

- **No ABI change.** The Diamond proxy address is unchanged, and no function signatures were added
  or changed. Your existing ABI fragments still work. What changed is *behaviour* and *fee math*.
- **The Diamond address is the same as always:**
  - Base: `0xbCC51E62C4948FD35ab505bd71804C849601e4Ef`
  - BSC: `0xaC939C0897981Abc0711ec4e37527F13106180fc` (behaviour below not live here yet)
- **Frontend has a real bug to fix now (Change 4):** the "recover capital" action is calling the
  wrong function. It used to fail silently-ish; after these upgrades it will hard-revert for users.

The five changes:
1. Settlement is now European (expiry only).
2. Fee model changed (hedger fee is now 5% of premium, payout & LP fees 2%, creation fee $25).
3. LP premiums are now claimable after capital withdrawal (recovers previously stuck funds).
4. "Recover capital" must call `withdrawCapital(depositId)`, not `recoverExpiredPayouts(eventId)`.
5. `recoverExpiredPayouts` is now owner-only.

---

## 1. Settlement is now European (expiry-only)

**What changed.** An event can only be settled at or after its `expiryDate`, in both settlement
paths (`settleEvent` and the oracle `submitRate` consensus). Previously an event could settle early
the moment the strike was touched. The trigger is now judged on the rate at expiry: a strike touched
mid-period but retraced by expiry does NOT pay out.

**Backend / oracle service — action required:**
- Do not attempt to settle before `expiryDate`; it reverts. Submit the settlement rate at or after
  expiry.
- This is now the ONLY way LP capital gets unlocked. Settlement must be reliable and prompt after
  each event expires; a stalled oracle strands LP capital until it runs.
- Revert string changed (see Change 6): update any error matching.

**Frontend — action required:**
- After expiry but before the oracle settles, the event is in a real "waiting" state. See Change 3
  for the exact status handling ("Awaiting settlement").

---

## 2. Fee model changed

New schedule (Base, live now). Rates use `PRECISION = 1e6`.

| Fee | Old | New | Charged when |
|---|---|---|---|
| Event creation fee | $2 | **$25** | `createEvent` |
| Hedger platform fee | 0.5% of **notional** | **5% of the PREMIUM** | `buyProtection` |
| Payout fee | 1% of payout | **2% of payout** | `claimPayout` |
| LP premium-claim fee | 1% of premium | **2% of premium** | `claimPremiums` |
| Creator loyalty | 5% of every fee | 5% (unchanged) | all of the above |

`getHedgeFeeConfig()` now returns `[25000000, 50000, 20000, 20000, 50000]` on Base.

**The important one is the hedger fee base change: notional → premium.** Update your cost math:

```
premium      = notional * premiumRate  / 1e6
platformFee  = premium  * hedgerFeeRate / 1e6      // hedgerFeeRate = 50000 (5%)
totalCost    = premium + platformFee               // this is what the hedger pays
```

Worked example: notional such that `premium = 1,000` USDC → hedger pays `1,000 + 50 = 1,050`.

Net amounts users receive:
```
payout claim : net = grossPayout * (1 - payoutFeeRate/1e6)   // * 0.98
premium claim: net = claimable   * (1 - lpProfitFeeRate/1e6) // * 0.98
```

**Frontend — action required:**
- Recompute the hedger cost preview with the new base (5% of premium, not 0.5% of notional).
- If you pass a `_maxCost` slippage guard to `buyProtection`, recompute it — the total is now
  smaller for the same notional, but the formula is different, so hardcoded values will be wrong.
- Update any displayed fee copy ("0.5% platform fee", "1% payout fee", etc.).

**Backend — action required:**
- Update any revenue/fee estimation and any cost figures shown in receipts, emails, or analytics.

**Snapshot caveat (both):** fee rates are snapshotted per event at `createEvent`. Events created
before this change keep the OLD rates; only NEW events use the new schedule. So `getHedgeFeeConfig()`
(global) is correct for new events, but an older still-open event may charge its old snapshot. For a
precise post-trade figure, read `platformFeePaid` off the position; for pre-trade preview, treat the
global config as an estimate and rely on the on-chain `_maxCost` guard.

---

## 3. LP premiums are claimable after capital withdrawal (and "Awaiting settlement")

**What changed.** Previously, once an LP called `withdrawCapital`, they could never claim their
premiums — any premium not claimed first was permanently stranded. That guard is removed. LPs can now
call `claimPremiums(depositId)` before OR after withdrawing capital.

- `pendingPremiums(depositId)` now returns the recoverable amount even for withdrawn deposits (it
  used to return 0 once withdrawn).
- On Base there is ~19.27 USDC of previously-stranded premiums that specific LPs can now reclaim.

**Frontend — action required:**
- Show pending premiums for a deposit **even after** its capital has been withdrawn, and offer a
  "Claim premiums" action whenever `pendingPremiums(depositId) > 0`.
- Prompt the affected LPs to reclaim (any deposit with `withdrawn == true` and
  `pendingPremiums > 0`). Best UX: when an LP withdraws capital, also claim premiums in the same flow
  (two calls, or surface both) so nothing is left behind going forward.

**Status handling — the "Expired" trap.** The contract never sets an `Expired` status; an event past
its `expiryDate` that has not been settled yet is still `Open (status 0)` on chain. Do not label it
"Expired" from the timestamp. Use:

| On-chain `status` | `now` vs `expiryDate` | Show as | LP `withdrawCapital`? |
|---|---|---|---|
| `0` Open | before expiry | Active | reverts "Cannot withdraw while event is active" |
| `0` Open | at/after expiry | **Awaiting settlement** | still reverts until oracle settles |
| `1` Settled | — | Settled / Resolved | allowed |

`withdrawCapital` only works once `status == 1 (Settled)`.

---

## 4. CRITICAL: "recover capital" must call the right function

**Problem observed in production.** The LP "recover capital" action is submitting
`recoverExpiredPayouts(eventId)`. That is the wrong function — it is an admin sweep of unclaimed
hedger payouts into platform fees, not an LP withdrawal, and after Change 5 it reverts "Not owner"
for any normal user. It also passed `eventId` where an LP function expects a `depositId`.

**Correct mapping of user actions to functions:**

| User action | Function | Argument |
|---|---|---|
| LP: withdraw capital | `withdrawCapital(uint256)` | **depositId** |
| LP: claim premiums | `claimPremiums(uint256)` | **depositId** |
| Hedger: claim payout | `claimPayout(uint256)` | **positionId** |
| (admin only) sweep stale payouts | `recoverExpiredPayouts(uint256)` | eventId — never wire to a user button |

Resolve the depositId first (do not pass eventId):

```ts
const depositIds = await diamond.getLpDepositIds(lpAddress);       // or getEventDepositIds(eventId)
let target;
for (const id of depositIds) {
  const d = await diamond.getHedgeLpDeposit(id);
  if (d.eventId === eventId && d.lp === lpAddress && !d.withdrawn) { target = id; break; }
}
await diamond.withdrawCapital(target);
```

**Frontend — action required:** fix this mapping. It is the highest-priority change in this doc.

---

## 5. `recoverExpiredPayouts` is now owner-only

**What changed.** `recoverExpiredPayouts(eventId)` was permissionless; it is now `onlyOwner`. It
sweeps a settled event's unclaimed hedger payouts into platform fees after a 90-day grace. It was
never meant to be a user action.

**Frontend — action required:** ensure no user-facing button calls it (see Change 4). If you have an
internal admin/ops tool, it must call from the owner wallet.

---

## 6. Changed revert strings

If any code matches revert reasons, update these:

| Function | Old reason | New reason / behaviour |
|---|---|---|
| `settleEvent` / `submitRate` before expiry | "Too early: event not expired and strike not yet reached" | "Too early: settlement only allowed at or after expiry" |
| `claimPremiums` after withdrawal | reverted "Capital already withdrawn: cannot claim premiums" | **now SUCCEEDS** (premium recovery) |
| `recoverExpiredPayouts` from a non-owner | (succeeded) | reverts "Not owner" |

---

## 7. Chain status

| Change | Base | BSC |
|---|---|---|
| European settlement | Live | Not yet |
| New fee model | Live | Not yet |
| LP premium recovery (F-11) | Live | Not yet |
| `recoverExpiredPayouts` owner-only | Live | Not yet |

BSC is blocked on a deployer gas top-up. Until BSC is upgraded, its diamond still has the OLD
behaviour and OLD fees. If your app serves BSC, gate any new behaviour on chainId until the BSC
upgrade is announced.

---

## 8. Action checklists

**Frontend**
- [ ] Fix "recover capital" to call `withdrawCapital(depositId)` (Change 4) — highest priority.
- [ ] Render `Open && now >= expiryDate` as "Awaiting settlement", not "Expired" (Change 3).
- [ ] Only enable capital withdrawal when `status == 1 (Settled)`.
- [ ] Show and allow claiming pending premiums for withdrawn deposits; prompt affected LPs (Change 3).
- [ ] Recompute hedger cost preview and `_maxCost` with the new fee math (Change 2).
- [ ] Update fee copy/labels (5% of premium, 2% payout, 2% LP, $25 creation).
- [ ] Ensure no user button calls `recoverExpiredPayouts` (Change 5).
- [ ] Gate new behaviour on chainId until BSC is upgraded (Change 7).

**Backend / oracle / pricing**
- [ ] Oracle settlement: submit only at/after `expiryDate`; make settlement timely and reliable
      (it is the only way LP capital unlocks now) (Change 1).
- [ ] Update revert-string matching (Change 6).
- [ ] Update any server-side cost / fee / revenue calculations to the new model (Change 2).
- [ ] Pricing engine: the signed-quote payload is unchanged (fees are not part of the signature), so
      no signing change is required — but update any cost figures you display or store.
- [ ] Keep BSC on the old assumptions until its upgrade lands (Change 7).
