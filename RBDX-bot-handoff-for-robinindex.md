# RBDX Arbitrage Bot — Handoff Report for RobinIndex

*Written 2026-09-06 for the RobinIndex protocol repo, to give that repo's
Claude session full context on the companion bot before mainnet launch.
Source: `RBDX-market-maker` repo (private, separate from RobinIndex —
holds live-key operational code and tuned strategy parameters that don't
belong in the public, audited-contracts repo).*

## 1. What this thing is

A companion off-chain bot + one small on-chain executor contract that keeps
**$RBDX** (RobinIndex's index token) trading near NAV and captures the
vault's own weight-deviation rebates. It is *not* part of the protocol —
it's a client of it, same trust level as any other arbitrageur, just one
you control. Full original design doc: `PLAN.md` in that repo (pre-build
spec, still the source of truth for thresholds/reasoning); day-to-day
status lives in `README.md`.

**Priority order of what it does:**
1. Keep RBDX near NAV on whatever DEX pool exists — mint/redeem against
   price gaps, rebalance the pool.
2. Independently of DEX activity, capture the vault's weight-deviation
   rebates (mint underweight assets / redeem overweight ones) — works even
   before real DEX liquidity exists.
3. Grow vault AUM over time by converting RBDX demand into deposited Stock
   Tokens (slow "flywheel", not a primary growth engine).

**What it explicitly does not do:** manufacture organic demand, or fix a
pool that's too shallow for real trade sizes. It's a rebalancer sitting on
top of whatever activity shows up.

## 2. Architecture

```
bot/          Off-chain TypeScript (viem), runs a read → decide → execute loop
  src/lib/       Ported vault math — math.ts is a byte-for-byte port of
                 RobinIndex's own fee/rebate math (_weightFeeBps, _applyFee,
                 _splitDevFee), pinned to RobinIndex commit eba989c. This is
                 the one piece that must never silently drift from the
                 deployed contract (see §5 below — this is the main ask).
  src/onchain/   Multicall reader against AssetRegistry / RBDXVault (+ DEX
                 pool reserves when configured)
  src/strategy/  Strategy A (DEX-vs-NAV arb) and Strategy B (vault-internal
                 rebalance) — independent code paths, separate sub-budgets
  src/safety/    Kill switch (file flag), daily-loss limit, stale-price guard
  src/executor/  Wallet-client wrapper — only fires when MODE=live AND the
                 relevant contract addresses are set
  src/ledger.ts  Append-only realized-profit/reinvestment ledger

contracts/    Foundry project, one production contract:
  RBDXArbExecutor.sol   Atomic one-tx executor. Owner-only, never holds a
                         balance between calls (_assertClean reverts if it
                         would). Two entry points:
                           executeMintArb   — premium leg: quote→StockToken
                             (swap) → vault.mint() → RBDX→quote (swap)
                           executeRedeemArb — discount leg: quote→RBDX
                             (swap) → vault.redeem() → StockToken→quote (swap)
                         Speaks a minimal IRBDXVaultMinimal interface
                         (mint(token, amount, minOut), redeem(token, rbdxAmount,
                         minOut)) and a generic UniswapV2-shaped router
                         interface — NOT audited yet.
  adapters/UniversalRouterV2Adapter.sol
                         Translates RBDXArbExecutor's swapExactTokensForTokens
                         calls into Uniswap Universal Router's execute()
                         (V2_SWAP_EXACT_IN command, payerIsUser:false). Needed
                         because Robinhood Chain mainnet's real Uniswap is
                         Universal Router, not a classic Router02.
                         RBDXArbExecutor.sol itself needs zero changes —
                         just point `router` at an adapter instance.
  testdex/               MiniSwap — a minimal Uniswap-V2 clone, testnet-only,
                         built because no usable Uniswap exists on Robinhood
                         Chain *testnet* to test against. Irrelevant to mainnet.
```

## 3. Dependency surface on the RobinIndex protocol (what this bot assumes)

This is the part most relevant to review from the protocol side — the bot's
correctness depends on these staying true:

- **`math.ts` is a hand-ported copy** of `RBDXVault.sol`'s fee/rebate math
  (weight-fee curve, dev-fee split), pinned to commit `eba989c`. **If
  `RBDXVault.sol` or `AssetRegistry.sol` change** — new params, a fee-curve
  upgrade — **the bot's copy needs a matching update before it runs against
  the new contract, not after.** This is the single biggest silent-drift
  risk in the whole system. Worth telling the RobinIndex session: flag any
  upcoming change to the fee/rebate math or `AssetRegistry` shape so the
  bot repo can re-port it.
- **`IRBDXVaultMinimal`** (in `RBDXArbExecutor.sol`) assumes `mint(address
  token, uint256 amount, uint256 minRbdxOut) returns (uint256)` and
  `redeem(address token, uint256 rbdxAmount, uint256 minAmountOut) returns
  (uint256)`. If the real vault's signature differs at all, the executor
  contract needs a matching edit before deploy.
- **Oracle assumption:** `OracleLib`/`RBDXVault` is built to consume a
  push-based `latestRoundData()` feed (Chainlink DataFeeds), which already
  bakes in the ERC-8056 corporate-action multiplier. The bot's mainnet
  asset list (`MAINNET_ASSETS`, see §4) is narrowed to exactly the Stock
  Tokens that have this kind of feed today — 32 of Robinhood's 194 listed
  Stock Tokens. The other 162 aren't usable by this contract design without
  a change (11 have only a paid Chainlink DataStreams feed requiring a
  per-call `verify()`, not a push feed; 151 have no Chainlink coverage at
  all). **If AssetRegistry's real deployed asset list doesn't match this
  narrowed set, or if oracle handling changes, that's a direct
  reconciliation point.**
- **`AssetRegistry`'s real deployed address list is not final yet** — the
  bot's `MAINNET_ASSETS` is populated from Robinhood's own public Stock
  Token registry API, independently of RobinIndex's own mainnet deployment
  (which hasn't happened). Once RobinIndex deploys `AssetRegistry` to
  mainnet, **its actual listed assets need to be reconciled against this
  32-asset candidate list** — same caveat already applies to the testnet
  asset list.
- **Quote asset:** confirmed on-chain as Robinhood Chain's native
  stablecoin **USDG** ("Global Dollar", Paxos), `0x5fc5360d0400a0fd4f2af552add042d716f1d168`,
  6 decimals — not USDC. If RobinIndex's own docs/tooling still assume
  USDC anywhere, that's worth flagging for consistency.
- **DEX:** confirmed on-chain that Uniswap v2/v3/v4 + Universal Router are
  live on Robinhood Chain mainnet (chain id 4663) — Universal Router is the
  real entry point, not a classic Router02. This only affects the bot repo
  (`UniversalRouterV2Adapter.sol`), not the protocol contracts, but is worth
  RobinIndex knowing in case its own frontend/tooling ever routes swaps.

## 4. Capital plan & launch sequence (as decided, PLAN.md §2/§11)

| | |
|---|---|
| Total budget | $1,000 |
| LP pool seed | $800 → $400 USDG + $400 RBDX |
| Bot working capital | $200 stablecoins |

Sequencing constraint: the $400 of RBDX for the pool doesn't exist yet — it
has to be minted first (which also functions as the vault's bootstrap
deposit, subject to `MIN_FIRST_DEPOSIT_USD = $100`). Order is:
1. Buy ~$400 of Stock Token(s) on the open market.
2. `vault.mint()` them → decides the vault's initial composition (spread
   across a few assets recommended, to avoid maximal single-name
   concentration at genesis).
3. Only then create the Uniswap pool with $400 USDG + the freshly-minted RBDX.

**Launch checklist (PLAN.md §11) — current status:**

| # | Item | Owner | Status |
|---|---|---|---|
| 1 | Confirm DEX availability + real mainnet gas price | bot repo | ✅ done (2026-09-05) |
| 2 | Deploy RobinIndex contracts to mainnet | **RobinIndex repo** | ⬜ not done |
| 3 | Buy ~$400 Stock Token(s), bootstrap the vault | ops | ⬜ not done |
| 4 | Create $400 USDG / $400 RBDX pool | ops | ⬜ not done |
| 5 | Compile + test executor contract | bot repo | ✅ done, deployed to testnet only |
| 6 | Dry-run bot against live mainnet conditions for days | bot repo | ⬜ not started |
| 7 | Fund bot hot wallet, flip to live with conservative limits | ops | ⬜ not done |
| 8 | Monitor 24-48h, kill switch within reach | ops | ⬜ not done |
| 9 | Track profit/reinvestment ledger from trade one | bot repo | ✅ mechanism built & verified on testnet |

**Item 2 is the actual blocker for everything downstream** — the bot repo
is otherwise ready to move to mainnet dry-run the day RobinIndex's contracts
and their addresses exist. This is likely the main thing worth surfacing to
the RobinIndex session: *what's RobinIndex's own timeline/status for
mainnet contract deployment, and can the bot repo get the deployed
addresses (token/registry/vault) as soon as they exist?*

## 5. Current build status (condensed — full detail in bot repo's README.md)

Proven end-to-end on Robinhood Chain **testnet only**, with a bot-owned
test wallet and play money. Not mainnet-ready, no real capital moved.

- 33/33 bot unit tests pass (vitest); math cross-checked against
  RobinIndex's own `test/RBDXVault.t.sol` vectors. 15/15 Foundry contract
  tests pass (RBDXArbExecutor + the Universal Router adapter, via mock).
- Real testnet transactions sent and confirmed for both strategies
  (Strategy B `vault.mint()`, Strategy A atomic `executeRedeemArb` through
  the executor) — executor's own balance verified at exactly zero after
  each, as designed.
- Caught and fixed a real decimals bug (6-decimal quote token vs an
  18-decimal assumption) via live testnet testing before it could hit real
  capital.
- Per-leg slippage bounds (`minStockOut`/`minRbdxOut`/`minQuoteOut`) are
  wired and verified live in both directions (correctly reverted a
  too-shallow fill; correctly executed once the pool was deepened).
- Realized-profit ledger now actually gets filled in from real transaction
  receipts (not just estimates), so the daily-loss safety check can
  actually trigger.
- Gas-cost assumption re-derived from real Robinhood Chain mainnet numbers
  (0.386 gwei, ~$2,480 ETH/USD, ~500k gas for a full dex-arb round trip):
  ~$0.33/iteration for Strategy B, ~$0.48–0.67 for Strategy A. Minimum
  chunk size raised to $65 accordingly (was a $10 testnet-era guess).
- `MAINNET_ASSETS` populated with 32 Stock Tokens (of Robinhood's 194) that
  have a usable Chainlink DataFeeds oracle — see §3.

## 6. Known limitations (read before ever flipping `MODE=live` on mainnet)

- **`MARKET_FRICTION_BPS` (flat 0.2% guess in `strategy/dexArb.ts`) is
  confirmed too optimistic** against real, if shallow, Stock Token
  liquidity — a live testnet trade lost more to slippage than predicted.
  Needs real market-depth data, not just a deeper RBDX/quote pool.
- **`UniversalRouterV2Adapter` has never executed against the real
  Universal Router or a real Robinhood Chain V2 pool** — only against a
  mock standing in for it (can't test further until a real pool exists).
- **`MAINNET_ASSETS` is a candidate list, not a confirmed one** — sourced
  from Robinhood's own registry, independent of RobinIndex's actual
  deployed `AssetRegistry` (which doesn't exist yet). Must be reconciled
  once it does.
- No wallet created/funded on mainnet, no contracts deployed to mainnet, no
  real capital moved yet.

## 7. Suggested questions for the RobinIndex session

- What's the timeline / current status for deploying `RBDXToken`,
  `AssetRegistry`, and `RBDXVault` to Robinhood Chain mainnet (checklist
  item 2)? The bot repo is otherwise blocked on this.
- Has anything in `RBDXVault.sol`'s fee/rebate math or `AssetRegistry.sol`'s
  interface changed since commit `eba989c`? If so, the bot's ported
  `math.ts` and `RBDXArbExecutor.sol`'s `IRBDXVaultMinimal` need updating
  before mainnet.
- Does RobinIndex's own mainnet asset list plan line up with the 32-asset
  Chainlink-DataFeeds-only candidate set above, or is broader oracle
  support (e.g. DataStreams) planned that would change which assets are
  viable?
- Any planned changes to `OracleLib`'s staleness/feed-consumption logic
  that the bot's own stale-price guard should mirror?

---
*Everything above is derived from the bot repo's `README.md` and `PLAN.md`
plus direct reading of `bot/src/config.ts` and
`contracts/src/RBDXArbExecutor.sol` as of this repo's latest commit
(`e1a4d6c`). Re-derive/re-check anything time-sensitive (gas price,
ETH/USD, Robinhood's asset registry) if much time has passed before acting
on it.*
