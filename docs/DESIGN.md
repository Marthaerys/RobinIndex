# RobinIndex ($RBDX) — Mechanism Design & Contract Spec

## 1. What this is

RBDX is a market-cap-weighted index token backed by Robinhood Chain Stock Tokens
(tokenized equities — NVDA, etc.). Users mint RBDX by depositing a single stock
token, and redeem RBDX for a single stock token of their choice. The price they get
is nudged by how much that trade moves the basket toward or away from its
market-cap target weight: a **rebate** for improving alignment, a **penalty** for
worsening it. This both (a) turns ordinary users/arbitrageurs into the rebalancing
mechanism — no active management needed — and (b) automatically shrinks a token's
influence on the index if its market cap collapses, which is the built-in defense
against one holding "depegging" the whole basket.

This is the same class of problem GMX's GLP vault solved for its multi-asset LP
token, and the design below deliberately follows that proven pattern rather than
inventing a new one.

## 2. What Robinhood Chain actually gives us (researched, not assumed)

- Stock Tokens are plain ERC-20 (18 decimals), **freely transferable with no
  whitelist for secondary holders** — a vault contract can hold/mint/burn against
  them and they're DEX-composable. Only *primary issuance* is KYB-gated (to BBVI as
  Authorized Participant) — irrelevant to us, since users deposit already-issued
  tokens. ([Stock Tokens spec](https://docs.robinhood.com/chain/stock-tokens/))
- Each Stock Token has a Chainlink feed (`AggregatorV3Interface`, `latestRoundData`),
  updating **24/5 during market hours only**. The reported price already bakes in
  the ERC-8056 corporate-action multiplier (dividends/splits), so `rawBalance *
  chainlinkPrice` is a correct fair USD value with no extra multiplier math needed.
  ([Oracles & Price Feeds](https://docs.robinhood.com/chain/oracles-and-price-feeds/))
- **Market cap is NOT available on-chain** — only price per token. Shares
  outstanding has to come from somewhere else. Per the user's decision, v1 sources
  this via an admin-updated registry (`AssetRegistry.sol`), not a fully trustless
  on-chain feed.

## 3. The math

Target weight (`i` ranges over listed assets):
```
marketCap_i    = sharesOutstanding_i * chainlinkPrice_i
targetWeight_i = marketCap_i / Σ_j marketCap_j
```

NAV and current weight:
```
NAV               = Σ_i (balance_i * chainlinkPrice_i)
currentWeight_i   = (balance_i * chainlinkPrice_i) / NAV
indexPrice        = NAV / totalSupply(RBDX)          // "$1 at genesis"
```

**Mint** token `i`, amount `A`: take the flat 0.1% dev fee first (see §5), then
price the remainder at `indexPrice`, adjusted by the weight fee/rebate computed
from how much the deposit moves `currentWeight_i` toward or away from
`targetWeight_i` (capped at ±1%, linear in the post-trade deviation — see
`RBDXVault._weightFeeBps`).

**Redeem** RBDX amount `R` into token `i`: mirror image — withdrawing an
**overweight** asset moves the basket toward target (rebate); withdrawing an
**underweight** one moves away (penalty). Same ±1% cap, same 0.1% dev fee taken
from the payout.

Worked example matching the user's own numbers: 100 stocks, $100M total market cap,
NVDA at $12M → `targetWeight_NVDA = 12%` — this is asserted directly in
`test_TargetWeights_Match12PercentExample`.

## 4. The anti-drain guarantee ("deposit A, farm B" — the user's original worry)

This was the central design constraint, so it's worth stating precisely:

**Rebates are only ever paid out of `rebateReserve`**, a USD-1e18 accounting ledger
— *not* a segregated pool, just a spending cap — funded exclusively by:
1. Penalty fees from trades that move the basket **away** from target weight, and
2. The `rebateFundingBps` slice (default 50%) of the 0.1% dev fee, which is
   deliberately **left in the vault's token balance** (never sent to
   `devTreasury`) specifically to physically back the reserve credit it generates.

Every rebate computation is clamped: `actualRebate = min(wantedRebate,
rebateReserve, <physical-balance-limit for redeem>)`. This makes
`Σ rebates paid ≤ Σ penalties collected + Σ reserve-funding dev fee` **true by
construction** — enforced in `RBDXVault._applyFee`, not argued informally. No
sequence of mints/redeems, however cleverly routed across assets, can extract more
USD value than was deposited plus what other users' penalties funded.

Two more layers, defense-in-depth beyond the reserve clamp:
- **Weights recompute every transaction** — an immediate reversal already faces a
  worse price before the reserve limit even matters.
- **Mint→transfer/redeem cooldown** (default 15 min, GMX/GLP precedent): a wallet
  that just minted cannot transfer *or* redeem for the cooldown window. This closes
  a hole a naive "only gate `redeem()`" design leaves open — a same-block
  mint-then-handoff-to-a-fresh-wallet-then-redeem round trip — see
  `test_Transfer_CooldownCannotBeBypassedViaFreshWallet`. **This was a genuine
  refinement made during implementation**: the original plan said only the
  vault-redemption path would be gated and the token would stay unrestricted; that
  turned out to be bypassable, so `RBDXToken._update` now also gates ordinary
  transfers from a recently-minted wallet. Net effect: a freshly-minted balance
  can't be flipped on a DEX for the first 15 minutes either — an accepted,
  deliberate trade-off, not a bug.

**Also caught during implementation** (see `test_Mint_OverweightAsset_GetsPenalty`
and the fix in `_weightFeeBps`): topping up the *sole* asset in a single-asset
vault can't push its weight fraction past 100% (it's already there), so that
specific trade is mathematically a tie (`devBefore == devAfter`), not a worsening —
the formula now treats exact ties as neutral (0 fee) rather than defaulting to a
rebate, which the original `<=` comparison silently did.

## 5. Fees

Flat **0.1% in-kind** fee on every mint (from the deposit) and every redeem (from
the payout), split by `rebateFundingBps` (default 50/50) between `devTreasury`
(paid out immediately) and `rebateReserve` (retained in-vault, see §4). Both knobs
are governance-adjustable within hard caps baked into the contract (`devFeeBps` ≤
1%, `maxWeightFeeBps` ≤ 5%) so misconfiguration can't turn the fee path into a rug.

## 6. Governance / trust surface

- `AssetRegistry`: `DEFAULT_ADMIN_ROLE` (intended: Gnosis Safe + timelock, never an
  EOA) lists/delists assets. `ASSET_MANAGER_ROLE` updates `sharesOutstanding`, capped
  at ±10% per call (`maxUpdateChangeBps`) so a compromised operational key can nudge
  weights, not instantly reweight the index.
- `RBDXVault`: `DEFAULT_ADMIN_ROLE` sets `devTreasury`, pauses/unpauses.
  `PARAM_ADMIN_ROLE` tunes fee/cooldown parameters, all hard-capped as above.
- These are genuine, disclosed trust assumptions (matching the fact that most index
  providers today also curate constituents/weights) — not trustlessness claims.

## 7. Contracts

| File | Role |
|---|---|
| `src/RBDXToken.sol` | ERC-20 share token; mint/burn restricted to the vault; transfer gated by mint-cooldown (§4). |
| `src/RBDXVault.sol` | Core: holds the basket, `mint()`/`redeem()`, NAV/weight math, fee + rebate-reserve accounting. |
| `src/AssetRegistry.sol` | Governance-controlled asset list, Chainlink feed addresses, shares-outstanding. |
| `src/libraries/OracleLib.sol` | Shared Chainlink read + staleness check + 18-decimal normalization. |
| `src/interfaces/` | `AggregatorV3Interface` (vendored), `IStockToken`. |
| `test/RBDXVault.t.sol` | Unit tests incl. the anti-drain scenario and the two bugs caught above. |

All builds/tests verified locally: `forge build` and `forge test` both pass
(12/12) as of this writeup — see §9.

## 8. Open questions (flagged, not blocking a testnet iteration)

- **After-hours behavior**: stock feeds don't update outside market hours; the
  chain presumably never sleeps. Right now `OracleLib` just reverts on staleness
  past `maxOracleStaleness` per asset — meaning mint/redeem naturally freezes
  off-hours if that's set tight, or stays open with a stale price if set loose.
  Needs an explicit choice before mainnet (freeze vs. widen bounds off-hours).
- **Regulatory**: wrapping/indexing these tokens into a permissionless, DEX-tradable
  derivative is a real open legal question, independent of the KYB-gating on
  primary issuance. Out of scope here technically — get counsel before launch.
- **Initial DEX liquidity** for RBDX itself (which DEX on Robinhood Chain, who
  seeds the first pool) — deferred to the frontend/launch phase.
- **Fee curve shape** (`_weightFeeBps`): the linear-capped-at-1% curve is a
  reasonable, simple default, but it's the one function most likely to get tuned
  pre-audit/pre-mainnet based on simulated market data.

## 9. Verification status

```
forge build   → Compiler run successful (via-ir enabled; RBDXVault.mint/redeem
                 have too many locals for the legacy codegen otherwise)
forge test    → 12 passed; 0 failed
```

Run locally:
```
export PATH="$PATH:$HOME/.foundry/bin"   # if not already on PATH
forge test -vv
```

Not yet done (next steps, not part of this pass): fuzz/invariant harness beyond the
single directed anti-drain test, testnet deployment scripts, frontend, initial DEX
liquidity.
