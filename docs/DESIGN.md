# RobinIndex ($RBDX) — Mechanism Design & Contract Spec

## 1. What this is

RBDX is an index token backed by Robinhood Chain Stock Tokens (tokenized equities —
NVDA, SpaceX, etc.). Users mint RBDX by depositing a single stock token, and redeem
RBDX for a single stock token of their choice. The price they get is nudged by how
much that trade moves the basket toward or away from its target weight: a
**rebate** for improving alignment, a **penalty** for worsening it. This both (a)
turns ordinary users/arbitrageurs into the rebalancing mechanism — no active
management needed — and (b) automatically shrinks a token's influence on the index
if its weight collapses, which is the built-in defense against one holding
"depegging" the whole basket.

This is the same class of problem GMX's GLP vault solved for its multi-asset LP
token, and the design below deliberately follows that proven pattern rather than
inventing a new one.

**What "target weight" tracks — a deliberate product decision, not a limitation:**
RBDX is *not* trying to mirror a real-world index like the S&P 500. Target weight is
driven by each Stock Token's own **on-chain circulating supply** (`totalSupply() *
Chainlink price`) — i.e. how much of that tokenized asset actually exists on
Robinhood Chain right now. Minting a Stock Token isn't a free/permissionless action
(only Robinhood's Authorized Participant can do it, against real underlying value —
see §2), so circulating supply is an honest signal of real capital deployed into
that asset on-chain. The result is an **AUM/adoption-weighted index of Robinhood
Chain's tokenized-equity ecosystem** — something like a tokenized SpaceX can
legitimately carry a large weight here despite not appearing in a real-world index
at all. A useful side effect: target weight is fully computed on-chain, live, from
data nobody has to curate — see §3 and §6.

## 2. What Robinhood Chain actually gives us (researched, not assumed)

- Stock Tokens are plain ERC-20 (18 decimals), **freely transferable with no
  whitelist for secondary holders** — a vault contract can hold/mint/burn against
  them and they're DEX-composable. Only *primary issuance* is KYB-gated (to BBVI as
  Authorized Participant) — irrelevant to holding/depositing already-issued tokens,
  but directly relevant to §1's weighting decision: nobody can inflate a token's
  `totalSupply()` for free, it costs real capital via that AP flow.
  ([Stock Tokens spec](https://docs.robinhood.com/chain/stock-tokens/))
- Each Stock Token has a Chainlink feed (`AggregatorV3Interface`, `latestRoundData`),
  updating **24/5 during market hours only**. The reported price already bakes in
  the ERC-8056 corporate-action multiplier (dividends/splits), so `rawBalance *
  chainlinkPrice` is a correct fair USD value with no extra multiplier math needed.
  ([Oracles & Price Feeds](https://docs.robinhood.com/chain/oracles-and-price-feeds/))
- **Real-world market cap (shares outstanding) is NOT available on-chain** — only
  price per token and each token's own `totalSupply()`. This is exactly why §1's
  weighting is defined off `totalSupply()` rather than real market cap: it's the
  only version of "how big is this position" that Robinhood Chain actually exposes
  trustlessly.

## 3. The math

Target weight (`i` ranges over listed assets) — fully on-chain, no admin input:
```
circulatingValue_i = totalSupply(token_i) * chainlinkPrice_i
targetWeight_i      = circulatingValue_i / Σ_j circulatingValue_j
```

NAV and current weight (based on what the *vault* holds, separate from the
totalSupply-based target above):
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

Worked example matching the user's own numbers: 100 tokens, $100M total on-chain
circulating value, NVDAx at $12M → `targetWeight_NVDAx = 12%` — asserted directly in
`test_TargetWeights_Match12PercentExample`, and `test_TargetWeight_TracksOnchainSupplyChanges_Live`
confirms weight shifts immediately when supply changes, no admin call involved.

**On the residual manipulation angle** (raised and correctly reasoned through by
the user): someone could buy up real exposure to a small token via Robinhood to
grow its on-chain supply and thus its target weight. This is real but structurally
self-limiting — it costs genuine 1:1 capital through the AP flow (not a cheap
exploit), and the only thing it buys is eligibility for a **rebate capped at 1% of
a single trade's value**. The cost of the "attack" dwarfs the capped reward.

## 4. The anti-drain guarantee ("deposit A, farm B" — the user's original worry)

This was the central design constraint, so it's worth stating precisely:

**Rebates are only ever paid out of `rebateReserve`**, a USD-1e18 accounting ledger
— *not* a segregated pool, just a spending cap — funded exclusively by:
1. Penalty fees from trades that move the basket **away** from target weight, and
2. Optionally, the `rebateFundingBps` slice (default **0%** — the reserve is
   funded entirely by penalties by default) of the 0.1% dev fee, which if
   nonzero is **left in the vault's token balance** (never sent to
   `devTreasury`) specifically to physically back the reserve credit it generates.

Every rebate computation is clamped: `actualRebate = min(wantedRebate,
rebateReserve, <physical-balance-limit for redeem>)`. This makes
`Σ rebates paid ≤ Σ penalties collected + Σ reserve-funding dev fee` **true by
construction** — enforced in `RBDXVault._applyFee`, not argued informally. No
sequence of mints/redeems, however cleverly routed across assets, can extract more
USD value than was deposited plus what other users' penalties funded.

One more layer, defense-in-depth beyond the reserve clamp:
- **Weights recompute every transaction** — an immediate reversal already faces a
  worse price before the reserve limit even matters.

**RBDX itself is always freely, immediately transferable — including tokens
someone just minted.** No cooldown ever touches a DEX trade. This was revisited
mid-build: an earlier version also gated ordinary transfers on a mint-cooldown
(mirroring GMX's GLP) to close a "mint on wallet A, hand off to fresh wallet B, B
redeems instantly" loophole. On reflection that loophole doesn't need closing —
the `rebateReserve` clamp above already bounds what *any* redemption can extract,
regardless of which wallet calls it or how fast, so gating transfers bought no real
safety margin while directly working against the goal of letting arbitrageurs react
instantly to a DEX-price/NAV gap. `test_FreshWalletRedeem_BypassesCooldown_
ButStaysReserveBounded` exercises exactly this pattern and confirms it stays
bounded. `RBDXVault.redeem()` keeps its own optional per-wallet cooldown
(`mintRedeemCooldown`, governance-configurable, can be set to 0) as a minor speed
bump against same-wallet round-trips through the vault specifically — it cannot
and does not touch transfers/DEX trading.

**Also caught during implementation** (see `test_Mint_OverweightAsset_GetsPenalty`
and the fix in `_weightFeeBps`): topping up the *sole* asset in a single-asset
vault can't push its weight fraction past 100% (it's already there), so that
specific trade is mathematically a tie (`devBefore == devAfter`), not a worsening —
the formula now treats exact ties as neutral (0 fee) rather than defaulting to a
rebate, which the original `<=` comparison silently did.

## 5. Fees

Flat **0.1% in-kind** fee on every mint (from the deposit) and every redeem (from
the payout), split by `rebateFundingBps` (default **0%**, i.e. all of it goes to
`devTreasury`) between `devTreasury` (paid out immediately) and `rebateReserve`
(retained in-vault, see §4 — funded entirely by penalties in the default config).
Both knobs
are governance-adjustable within hard caps baked into the contract (`devFeeBps` ≤
1%, `maxWeightFeeBps` ≤ 5%) so misconfiguration can't turn the fee path into a rug.

## 6. Governance / trust surface

Deliberately minimal, now that target weight is 100% on-chain data (§1, §3):

- `AssetRegistry`: `DEFAULT_ADMIN_ROLE` (intended: Gnosis Safe + timelock, never an
  EOA) is the *only* trust surface here — it decides which assets are listed
  (`addAsset`/`delistAsset`, i.e. which Chainlink feed to trust for a given token).
  There is no data-update role at all: no shares-outstanding to keep fresh, no
  keeper bot, no staleness-of-curation risk.
- `RBDXVault`: `DEFAULT_ADMIN_ROLE` sets `devTreasury`, pauses/unpauses.
  `PARAM_ADMIN_ROLE` tunes fee/cooldown parameters, all hard-capped in the contract
  (`devFeeBps` ≤ 1%, `maxWeightFeeBps` ≤ 5%, `mintRedeemCooldown` ≤ 1 day).
- These are genuine, disclosed trust assumptions (which assets are even eligible)
  — not trustlessness claims — but they're materially smaller than a typical index
  provider's curation surface, since weights themselves need no curation.

## 7. Contracts

| File | Role |
|---|---|
| `src/RBDXToken.sol` | Plain ERC-20 share token; mint/burn restricted to the vault. No transfer restrictions (§4). |
| `src/RBDXVault.sol` | Core: holds the basket, `mint()`/`redeem()`, NAV/weight math, fee + rebate-reserve accounting. |
| `src/AssetRegistry.sol` | Governance-controlled asset list + Chainlink feed addresses; target weight computed live from on-chain `totalSupply()` (§1, §3) — no admin-fed data. |
| `src/libraries/OracleLib.sol` | Shared Chainlink read + staleness check + 18-decimal normalization. |
| `src/interfaces/` | `AggregatorV3Interface` (vendored), `IStockToken`. |
| `test/RBDXVault.t.sol` | Unit tests incl. the anti-drain scenario and the bugs caught along the way (§4). |

All builds/tests verified locally: `forge build` and `forge test` both pass
(11/11) as of this writeup — see §9.

## 8. Open questions (flagged, not blocking a testnet iteration)

- **After-hours behavior — resolved**: stock feeds don't update outside market
  hours; the chain never sleeps. `OracleLib` still reverts on staleness past
  `maxOracleStaleness` per asset (mint/redeem of *that* asset naturally freezes
  off-hours if its staleness bound is tight, or trades on a stale price if set
  loose — that per-asset tradeoff is still each asset's own `maxOracleStaleness`
  setting, unchanged). What's now fixed: that staleness no longer *cascades* —
  `RBDXVault._nav()` and `AssetRegistry.totalCirculatingValue()` both skip a
  reverting asset (try/catch on a self-external-call) instead of reverting the
  whole computation, so one stale/broken feed only freezes mint/redeem of that
  one asset, never every other listed asset too. If *every* feed goes stale at
  once (e.g. a full market closure with tight bounds), every asset's own trade
  still correctly freezes individually — there's no scenario left where a single
  bad feed takes down assets that aren't themselves affected.
- **Regulatory — deliberately deferred, not resolved**: wrapping/indexing these
  tokens into a permissionless, DEX-tradable derivative is a real open legal
  question (is $RBDX itself a security, does the vault resemble a regulated
  exchange/investment vehicle, does jurisdiction matter), independent of the
  KYB-gating on primary issuance — Robinhood's own compliance work on the
  underlying Stock Tokens doesn't automatically extend to a derivative built on
  top of them. Out of scope for this codebase technically. Explicit decision
  (2026-09): given the intended pilot-scale/effectively-single-operator launch,
  formal legal counsel is consciously deferred rather than skipped outright —
  see the disclaimer in the root [README.md](../README.md). **This stops being
  deferrable the moment usage, marketing, or capital meaningfully grows** —
  revisit before any of those happen, not after.
- **Initial DEX liquidity** for RBDX itself (which DEX on Robinhood Chain, who
  seeds the first pool) — deferred to the frontend/launch phase.
- **Fee curve shape — finalized as-is**: the linear-capped-at-1% curve
  (`_weightFeeBps`) is the shipped mainnet design, not a placeholder. Explicit
  decision (2026-09): given the intended pilot scale, tuning against alternative
  shapes (quadratic, stepped, etc.) isn't worth the effort now — the ±1% cap and
  the `rebateReserve` clamp make solvency independent of curve shape either way
  (see the security-audit fix commits), so a suboptimal-but-safe curve is an
  acceptable tradeoff. One known, accepted quirk (informational, not a bug):
  magnitude scales off post-trade deviation (`devAfter`) rather than the
  improvement (`devBefore - devAfter`), so a trade that only partially corrects
  a large deviation can score similarly to one that fully corrects it. Revisit
  if real trading volume ever makes this worth optimizing.

## 9. Verification status

```
forge build   → Compiler run successful (via-ir enabled; RBDXVault.mint/redeem
                 have too many locals for the legacy codegen otherwise)
forge test    → 11 passed; 0 failed
```

Run locally:
```
export PATH="$PATH:$HOME/.foundry/bin"   # if not already on PATH
forge test -vv
```

Not yet done (next steps, not part of this pass): fuzz/invariant harness beyond the
single directed anti-drain test, testnet deployment scripts, frontend, initial DEX
liquidity.
