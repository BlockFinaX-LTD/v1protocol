# Archived deploy/upgrade scripts

These scripts ran historical one-time operations that are now baked into the
production state of the deployed Diamonds. Kept here for git history and auditability,
**not for re-execution.**

| Script | What it did | Successor (live) |
|---|---|---|
| `upgrade-hedge-facet.js`, `-final.js`, `-v3.js`, `-v5.js` | Pre-v8 HedgeFacet upgrades | `../upgrade-hedge-v8.js` |
| `upgrade-rescue-erc20.js` | Added rescueERC20() to existing facets | folded into v8 facet |
| `upgrade-v6-audit.js`, `execute-v6-audit.js` | v6 audit fixes | folded into v8 facet |
| `deploy-v2-fixes.js`, `deploy-v3-fixed.js`, `post-upgrade-v3.js` | Successive Diamond bootstrap iterations | `../deploy-diamond.js` |
| `resume-mainnet-cut.js` | Recovery script for an interrupted mainnet cut | n/a |
| `safe-execute-v6.js` | Safe-multisig execution for v6 audit cut | n/a (deployer key now owns Diamonds again, see `check-ownership-direct.js`) |
| `safe-accept-ownership.js` | Was for finishing the legacy Lisk Diamond's Safe ownership transfer; never executed on the current Diamonds (deployer still owns them) | n/a |
| `update-fee.js`, `update-creation-fee-multichain.js` | One-shot fee updates against legacy Diamonds (single-chain + Safe-based multi-chain) | call `initializeHedgeFees(...)` directly with the deployer key — no script needed |
| `verify-all-chains.js` | Block-explorer verification snapshot for legacy facets/Diamonds | run `npx hardhat verify` per-contract for current deployments |
| `transfer-ownership-to-safe.js`, `transfer-to-wallet.js` | One-shot ownership transfers against a legacy Base Diamond — Safe ownership was never installed on the current Diamonds | n/a (deployer key still owns current Diamonds) |
| `check-ownership.js` | Single-chain ownership check, hard-coded to a legacy Diamond | `../check-ownership-direct.js` (multi-chain, current Diamonds) |

If you need to understand a past upgrade decision, read the file. If you need to
**run** an upgrade, use the active scripts in `../`.
