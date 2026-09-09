// SPDX-License-Identifier: MIT
//
// Is there a business case for swapping one Stock Token for another THROUGH the
// RBDX vault (mint tokenIn -> redeem tokenOut) instead of routing GOOGL -> USDG
// -> NVDA over two Uniswap pools?
//
// Both routes are priced end-to-end and reported as an all-in cost in bps
// against the Chainlink mid — so a number here is "what fraction of your
// notional you lose by taking this route", directly comparable between the two.
//
// Vault fee/rebate math is a line-for-line port of RBDXVault.sol
// (_weightFeeBps/_applyFee/_splitDevFee), same approach as sim/arbBotSim.mjs:
// plain floating point, fine for a feasibility study, NOT consensus-critical.
//
// Target weights are REAL: script/analytics/leaderboard.json, the on-chain
// totalSupply x price snapshot for the 27 listed assets.
//
// Run: node sim/swapRouteSim.mjs

import { readFileSync, writeFileSync } from "node:fs";

const BPS = 10_000;

// ── Vault fee math (ported from RBDXVault.sol) ───────────────────────────

function splitDevFee(grossAmount, devFeeBps, rebateFundingBps) {
  const devFeeAmount = (grossAmount * devFeeBps) / BPS;
  const devFeeToTreasury = (devFeeAmount * (BPS - rebateFundingBps)) / BPS;
  return { netAmount: grossAmount - devFeeAmount, devFeeToReserve: devFeeAmount - devFeeToTreasury };
}

function weightFeeBps(currentWeight, targetWeight, nextWeight, maxWeightFeeBps) {
  const devBefore = Math.abs(currentWeight - targetWeight);
  const devAfter = Math.abs(nextWeight - targetWeight);
  const referenceWeight = targetWeight > 0 ? targetWeight : 0.1;
  let magnitudeBps = (devAfter * maxWeightFeeBps) / referenceWeight;
  if (magnitudeBps > maxWeightFeeBps) magnitudeBps = maxWeightFeeBps;
  if (devAfter === devBefore) return 0;
  return devAfter < devBefore ? -magnitudeBps : magnitudeBps;
}

function applyFee(usdAmount, feeBps, maxRebateUsd, rebateReserve) {
  if (feeBps >= 0) {
    const penaltyUsd = (usdAmount * feeBps) / BPS;
    return { effectiveUsd: usdAmount - penaltyUsd, reserveDelta: penaltyUsd, clamped: false };
  }
  const wanted = (usdAmount * -feeBps) / BPS;
  let actual = wanted;
  let clamped = false;
  if (actual > rebateReserve) { actual = rebateReserve; clamped = true; }
  if (actual > maxRebateUsd) { actual = maxRebateUsd; clamped = true; }
  return { effectiveUsd: usdAmount + actual, reserveDelta: -actual, clamped };
}

// ── Real target weights ──────────────────────────────────────────────────

const LISTED = ["AAPL","AMD","AMZN","ASML","BABA","CLSK","COIN","CRCL","CRWV","GME","GOOGL","INTC","IONQ","META","MSFT","MSTR","MU","NBIS","NVDA","ORCL","PLTR","RGTI","RKLB","SNDK","SPCX","TSLA","TSM"];

const lb = JSON.parse(readFileSync(new URL("../script/analytics/leaderboard.json", import.meta.url)));
const rows = lb.rows.filter((r) => LISTED.includes(r.symbol) && r.usd > 0);
if (rows.length !== LISTED.length) throw new Error(`expected ${LISTED.length} listed assets, got ${rows.length}`);
const totalCirc = rows.reduce((a, r) => a + r.usd, 0);

const PRICE = Object.fromEntries(rows.map((r) => [r.symbol, r.price]));
const TARGET_WEIGHT = Object.fromEntries(rows.map((r) => [r.symbol, r.usd / totalCirc]));

const VAULT_PARAMS = { devFeeBps: 10, rebateFundingBps: 0, maxWeightFeeBps: 100 }; // today's on-chain config

// ── Vault model ──────────────────────────────────────────────────────────

/** Vault sitting at `navUsd`, each asset at `weightOverride ?? target`. */
function makeVault(navUsd, rebateReserve = 0, weightOverride = {}) {
  const assets = {};
  for (const sym of LISTED) {
    const w = weightOverride[sym] ?? TARGET_WEIGHT[sym];
    assets[sym] = { price: PRICE[sym], balance: (w * navUsd) / PRICE[sym] };
  }
  return { assets, supply: navUsd, rebateReserve }; // index price starts at $1
}

const nav = (v) => Object.values(v.assets).reduce((s, a) => s + a.balance * a.price, 0);
const weightOf = (v, sym) => (v.assets[sym].balance * v.assets[sym].price) / nav(v);

function mint(vault, sym, usdGross) {
  const asset = vault.assets[sym];
  const { netAmount, devFeeToReserve } = splitDevFee(usdGross / asset.price, VAULT_PARAMS.devFeeBps, VAULT_PARAMS.rebateFundingBps);
  const navPre = nav(vault);
  const usdIn = netAmount * asset.price;
  const indexPricePre = navPre / vault.supply;

  const curW = weightOf(vault, sym);
  const navAfter = navPre + usdIn;
  const nextW = navAfter === 0 ? 0 : ((asset.balance + netAmount) * asset.price) / navAfter;

  const feeBps = weightFeeBps(curW, TARGET_WEIGHT[sym], nextW, VAULT_PARAMS.maxWeightFeeBps);
  const { effectiveUsd, reserveDelta, clamped } = applyFee(usdIn, feeBps, Infinity, vault.rebateReserve);
  const rbdxOut = effectiveUsd / indexPricePre;

  asset.balance += netAmount;
  vault.rebateReserve += reserveDelta + devFeeToReserve * asset.price;
  vault.supply += rbdxOut;
  return { rbdxOut, feeBps, clamped };
}

function redeem(vault, sym, rbdxIn) {
  const asset = vault.assets[sym];
  const navPre = nav(vault);
  const indexPricePre = navPre / vault.supply;
  const usdAmount = rbdxIn * indexPricePre;
  const notionalTokenOut = usdAmount / asset.price;
  // RBDXVault.redeem reverts with InsufficientVaultBalance before doing anything else.
  if (notionalTokenOut > asset.balance) return { tokenOut: 0, feeBps: 0, reverted: "InsufficientVaultBalance" };

  const curW = weightOf(vault, sym);
  const navAfter = navPre - usdAmount;
  const nextW = navAfter === 0 ? 0 : ((asset.balance - notionalTokenOut) * asset.price) / navAfter;

  const feeBps = weightFeeBps(curW, TARGET_WEIGHT[sym], nextW, VAULT_PARAMS.maxWeightFeeBps);
  const maxRebateUsd = (asset.balance - notionalTokenOut) * asset.price;
  const { effectiveUsd, reserveDelta, clamped } = applyFee(usdAmount, feeBps, maxRebateUsd, vault.rebateReserve);
  const { netAmount: tokenOut, devFeeToReserve } = splitDevFee(effectiveUsd / asset.price, VAULT_PARAMS.devFeeBps, VAULT_PARAMS.rebateFundingBps);

  asset.balance -= notionalTokenOut;
  vault.rebateReserve += reserveDelta + devFeeToReserve * asset.price;
  vault.supply -= rbdxIn;
  return { tokenOut, feeBps, clamped };
}

/** Full swapViaIndex(tokenIn, tokenOut, usdNotional). Cost in bps vs. Chainlink mid. */
function rbdxSwap(vault, symIn, symOut, usdNotional) {
  const m = mint(vault, symIn, usdNotional);
  const r = redeem(vault, symOut, m.rbdxOut);
  if (r.reverted) return { costBps: Infinity, reverted: r.reverted };
  const usdOut = r.tokenOut * vault.assets[symOut].price;
  return {
    costBps: ((usdNotional - usdOut) / usdNotional) * BPS,
    mintFeeBps: m.feeBps,
    redeemFeeBps: r.feeBps,
    clamped: m.clamped || r.clamped,
  };
}

// ── Uniswap model ────────────────────────────────────────────────────────

/// Two constant-product hops through USDG, the route a v4 router takes when no
/// direct GOOGL/NVDA pool exists (none does on Robinhood Chain today).
///
/// ASSUMPTION, and the one that decides this whole comparison: total DEX TVL
/// equals the vault's NAV (the user's "equally liquid" premise), split across
/// the 27 stock/USDG pools in proportion to the same circulating-value weights,
/// each pool half stock / half USDG. `concentration` is the v4 concentrated-
/// liquidity multiplier on effective in-range depth -- 1 = full-range v2-style,
/// 50 = tight, actively managed band. Reserves are treated in USD value terms,
/// which is exact for a CPMM at the current mid.
function uniswapSwap(symIn, symOut, usdNotional, { tvl, feeBps, concentration }) {
  const halfPool = (sym) => (concentration * TARGET_WEIGHT[sym] * tvl) / 2;
  const hop = (reserveIn, reserveOut, amountIn) => {
    const net = amountIn * (1 - feeBps / BPS);
    return (reserveOut * net) / (reserveIn + net);
  };
  const usdg = hop(halfPool(symIn), halfPool(symIn), usdNotional);
  const out = hop(halfPool(symOut), halfPool(symOut), usdg);
  return { costBps: ((usdNotional - out) / usdNotional) * BPS };
}

// ── Scenarios ────────────────────────────────────────────────────────────

const CAPITAL = 10_000_000; // $10M, both as vault NAV and as total DEX TVL
const DEX_CONFIGS = [
  { label: "v4 0.05% flat", feeBps: 5, concentration: 1 },
  { label: "v4 0.05% conc.10x", feeBps: 5, concentration: 10 },
  { label: "v4 0.05% conc.50x", feeBps: 5, concentration: 50 },
  { label: "v4 0.30% conc.10x", feeBps: 30, concentration: 10 },
];
const SIZES = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];

const pct = (x) => ((100 * x) / CAPITAL).toFixed(3) + "%";
const bps = (x) => (x === Infinity ? "revert" : x.toFixed(1));

console.log(`RobinIndex swap-route comparison — GOOGL -> NVDA`);
console.log(`Capital: $${(CAPITAL / 1e6).toFixed(0)}M as vault NAV AND as total DEX TVL (the "equally liquid" premise)`);
console.log(`Target weights: real, from leaderboard.json @ ${lb.at}`);
console.log(`GOOGL ${(100 * TARGET_WEIGHT.GOOGL).toFixed(2)}% | NVDA ${(100 * TARGET_WEIGHT.NVDA).toFixed(2)}%`);
console.log(`Vault: devFee ${VAULT_PARAMS.devFeeBps}bps/leg, weight fee capped at ${VAULT_PARAMS.maxWeightFeeBps}bps/leg\n`);

console.log("── All-in cost in bps vs Chainlink mid ──");
console.log(["trade$".padStart(10), "of NAV".padStart(8), "RBDX".padStart(8), ...DEX_CONFIGS.map((c) => c.label.padStart(18))].join(""));
const sizeTable = [];
for (const size of SIZES) {
  const v = makeVault(CAPITAL);
  const r = rbdxSwap(v, "GOOGL", "NVDA", size);
  const dex = DEX_CONFIGS.map((c) => uniswapSwap("GOOGL", "NVDA", size, { tvl: CAPITAL, ...c }).costBps);
  sizeTable.push({ size, rbdxBps: r.costBps, mintFeeBps: r.mintFeeBps, redeemFeeBps: r.redeemFeeBps, dexBps: dex });
  console.log([
    ("$" + size.toLocaleString("en-US")).padStart(10),
    pct(size).padStart(8),
    bps(r.costBps).padStart(8),
    ...dex.map((d) => bps(d).padStart(18)),
  ].join(""));
}

// Break-even: the trade size where RBDX becomes the cheaper route.
console.log("\n── Break-even trade size (RBDX becomes cheaper above this) ──");
const crossovers = [];
for (const c of DEX_CONFIGS) {
  let lo = 1, hi = CAPITAL * 0.2, found = null;
  const cheaper = (x) => {
    const v = makeVault(CAPITAL);
    return rbdxSwap(v, "GOOGL", "NVDA", x).costBps < uniswapSwap("GOOGL", "NVDA", x, { tvl: CAPITAL, ...c }).costBps;
  };
  if (cheaper(lo)) found = 0; // RBDX cheaper even at dust size
  else if (!cheaper(hi)) found = null; // DEX cheaper across the whole range
  else {
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (cheaper(mid)) hi = mid; else lo = mid; }
    found = hi;
  }
  crossovers.push({ config: c.label, breakEvenUsd: found });
  console.log(
    `  ${c.label.padEnd(20)} ${found === null ? "never (DEX always cheaper up to $" + (CAPITAL * 0.2).toLocaleString("en-US") + ")"
      : found === 0 ? "always (RBDX cheaper at every size)"
      : "$" + Math.round(found).toLocaleString("en-US") + "  (" + pct(found) + " of NAV)"}`,
  );
}

// The weight-fee scales with 1/targetWeight, so which PAIR you trade matters
// far more than which direction.
console.log("\n── Pair matters: RBDX cost in bps on a $50k swap (0.5% of NAV) ──");
const PAIRS = [["NVDA","SPCX"],["GOOGL","NVDA"],["NVDA","GOOGL"],["AAPL","TSLA"],["GOOGL","META"],["ORCL","CRWV"],["RKLB","IONQ"],["CLSK","RGTI"]];
const pairTable = [];
for (const [a, b] of PAIRS) {
  const v = makeVault(CAPITAL);
  const r = rbdxSwap(v, a, b, 50_000);
  const d = uniswapSwap(a, b, 50_000, { tvl: CAPITAL, feeBps: 5, concentration: 10 }).costBps;
  pairTable.push({ pair: `${a}->${b}`, wIn: TARGET_WEIGHT[a], wOut: TARGET_WEIGHT[b], rbdxBps: r.costBps, dexBps: d, reverted: r.reverted ?? null });
  console.log(
    `  ${(a + " -> " + b).padEnd(16)} weights ${(100 * TARGET_WEIGHT[a]).toFixed(2).padStart(5)}% / ${(100 * TARGET_WEIGHT[b]).toFixed(2).padStart(5)}%   RBDX ${bps(r.costBps).padStart(7)}   DEX(0.05%,10x) ${bps(d).padStart(8)}`,
  );
}

// The case nobody else can offer: the vault is off-target and PAYS you to fix it.
console.log("\n── Rebalancing flow: vault already off-target, swap moves it back ──");
const rebalTable = [];
for (const skewPp of [0, 1, 2, 3]) {
  // GOOGL sits underweight by skewPp points and NVDA overweight by the same.
  // A GOOGL->NVDA swap hands the vault GOOGL (fixing the shortfall) and takes
  // NVDA out (fixing the excess), so BOTH legs move toward target and both earn
  // a rebate instead of a penalty -- the vault paying someone to rebalance it.
  const override = { ...TARGET_WEIGHT };
  override.GOOGL = TARGET_WEIGHT.GOOGL - skewPp / 100;
  override.NVDA = TARGET_WEIGHT.NVDA + skewPp / 100;
  const reserve = CAPITAL * 0.001; // 0.1% of NAV sitting in the rebate reserve
  const v = makeVault(CAPITAL, reserve, override);
  const r = rbdxSwap(v, "GOOGL", "NVDA", 50_000);
  rebalTable.push({ skewPp, costBps: r.costBps, mintFeeBps: r.mintFeeBps ?? null, redeemFeeBps: r.redeemFeeBps ?? null, clamped: r.clamped ?? null, reverted: r.reverted ?? null });
  console.log(
    `  skew ${skewPp}pp   GOOGL -> NVDA $50k:  all-in ${bps(r.costBps).padStart(8)} bps` +
    (r.reverted ? `   (${r.reverted})`
      : `   (mint leg ${r.mintFeeBps.toFixed(1)}, redeem leg ${r.redeemFeeBps.toFixed(1)}${r.clamped ? ", REBATE CLAMPED by reserve" : ""})`),
  );
}

writeFileSync(new URL("./swapRouteResults.json", import.meta.url), JSON.stringify({
  generatedAt: new Date().toISOString(),
  leaderboardAt: lb.at,
  capital: CAPITAL,
  vaultParams: VAULT_PARAMS,
  targetWeights: TARGET_WEIGHT,
  dexConfigs: DEX_CONFIGS,
  sizeTable, crossovers, pairTable, rebalTable,
}, null, 2));
console.log("\nWrote sim/swapRouteResults.json");
