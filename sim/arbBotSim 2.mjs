// SPDX-License-Identifier: MIT
//
// Feasibility simulation for a $500-stables arbitrage/market-maker bot
// recycling capital through: buy Stock Token -> vault.mint() -> sell RBDX on
// a thin Uniswap pool (and the mirror: buy cheap RBDX -> vault.redeem() ->
// sell Stock Token), against a $500-seeded RBDX/USDC pool. NOT the bot itself
// -- just a numbers check before building it for real (see chat history for
// context). The bot's real execution code stays in its own separate repo.
//
// Fee/rebate math below is a line-for-line port of frontend/src/lib/math.ts
// (itself a port of RBDXVault.sol's _weightFeeBps/_applyFee/_splitDevFee),
// using plain floating point instead of bigint -- fine for a feasibility
// study, NOT for anything consensus-critical.
//
// Run: node sim/arbBotSim.mjs

// ── Vault fee/rebate math (ported from RBDXVault.sol / frontend/src/lib/math.ts) ──

const BPS = 10_000;

function splitDevFee(grossAmount, devFeeBps, rebateFundingBps) {
  const devFeeAmount = (grossAmount * devFeeBps) / BPS;
  const devFeeToTreasury = (devFeeAmount * (BPS - rebateFundingBps)) / BPS;
  const devFeeToReserve = devFeeAmount - devFeeToTreasury;
  return { netAmount: grossAmount - devFeeAmount, devFeeToReserve };
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

/** Returns { effectiveUsd, reserveDelta, clamped }. feeBps>=0 (penalty) always succeeds
 *  and funds the reserve; feeBps<0 (rebate) is clamped to reserve & maxRebateUsd. */
function applyFee(usdAmount, feeBps, maxRebateUsd, rebateReserve) {
  if (feeBps >= 0) {
    const penaltyUsd = (usdAmount * feeBps) / BPS;
    return { effectiveUsd: usdAmount - penaltyUsd, reserveDelta: penaltyUsd, clamped: false };
  }
  const wantedRebateUsd = (usdAmount * -feeBps) / BPS;
  let actualRebateUsd = wantedRebateUsd;
  let clamped = false;
  if (actualRebateUsd > rebateReserve) { actualRebateUsd = rebateReserve; clamped = true; }
  if (actualRebateUsd > maxRebateUsd) { actualRebateUsd = maxRebateUsd; clamped = true; }
  return { effectiveUsd: usdAmount + actualRebateUsd, reserveDelta: -actualRebateUsd, clamped };
}

// ── Vault state ──────────────────────────────────────────────────────────

/** 5 real testnet-listed assets (TSLA/AMZN/PLTR/NFLX/AMD), identical on-chain
 *  totalSupply per the current testnet deployment -> target weight is purely
 *  price-proportional, matching the "NFLX ~54.7%" figure already observed live. */
const ASSET_PRICES = { TSLA: 420, AMZN: 225, PLTR: 180, NFLX: 1200, AMD: 170 };
const PRICE_SUM = Object.values(ASSET_PRICES).reduce((a, b) => a + b, 0);
const TARGET_WEIGHT = Object.fromEntries(
  Object.entries(ASSET_PRICES).map(([sym, price]) => [sym, price / PRICE_SUM]),
);

const VAULT_PARAMS = { devFeeBps: 10, rebateFundingBps: 0, maxWeightFeeBps: 100 }; // matches today's on-chain config
const INITIAL_NAV = 1000; // vault already bootstrapped, sitting ~at target weight
const MARKET_FRICTION_BPS = 20; // ASSUMPTION: spread/slippage buying/selling Stock Tokens on Robinhood Chain's own market -- no real depth data for this, flagged explicitly
const UNISWAP_FEE_BPS = 30; // standard v2 fee tier
const GAS_COST_USD = 0.10; // ASSUMPTION: bundled atomic buy+mint(or redeem)+swap in one tx, ~600k gas @ 0.05 gwei, ETH=$2500 (see gas benchmark commit for the per-op numbers this is built from)
const MIN_EDGE_BPS = 30; // stop once the DEX/NAV gap is smaller than this (not worth chasing)
const MAX_ITERATIONS = 500;

function makeVault(navSeed = INITIAL_NAV, rebateReserve = 0) {
  const assets = {};
  for (const [sym, price] of Object.entries(ASSET_PRICES)) {
    const usdValue = TARGET_WEIGHT[sym] * navSeed; // start exactly at target weight
    assets[sym] = { price, balance: usdValue / price };
  }
  return { assets, supply: navSeed / 1 /* $1 genesis index price */, rebateReserve };
}

function vaultNav(vault) {
  return Object.values(vault.assets).reduce((sum, a) => sum + a.balance * a.price, 0);
}

function indexPrice(vault) {
  return vaultNav(vault) / vault.supply;
}

function currentWeight(vault, sym) {
  const a = vault.assets[sym];
  return (a.balance * a.price) / vaultNav(vault);
}

/** Mint RBDX by depositing `usdGross` worth of `sym`. Mutates vault in place. Returns rbdxOut. */
function mint(vault, sym, usdGross) {
  const asset = vault.assets[sym];
  const grossAmount = usdGross / asset.price;
  const { netAmount, devFeeToReserve } = splitDevFee(grossAmount, VAULT_PARAMS.devFeeBps, VAULT_PARAMS.rebateFundingBps);
  const navPre = vaultNav(vault);
  const usdIn = netAmount * asset.price;
  const indexPricePre = navPre / vault.supply;

  const curW = currentWeight(vault, sym);
  const navAfter = navPre + usdIn;
  const nextBalanceValue = (asset.balance + netAmount) * asset.price;
  const nextW = navAfter === 0 ? 0 : nextBalanceValue / navAfter;

  const feeBps = weightFeeBps(curW, TARGET_WEIGHT[sym], nextW, VAULT_PARAMS.maxWeightFeeBps);
  const { effectiveUsd, reserveDelta } = applyFee(usdIn, feeBps, Infinity, vault.rebateReserve);
  const rbdxOut = effectiveUsd / indexPricePre;

  asset.balance += netAmount;
  vault.rebateReserve += reserveDelta + devFeeToReserve * asset.price;
  vault.supply += rbdxOut;
  return { rbdxOut, feeBps, usdSpent: usdGross };
}

/** Redeem `rbdxIn` RBDX for `sym`. Mutates vault in place. Returns tokenOut (in `sym` units). */
function redeem(vault, sym, rbdxIn) {
  const asset = vault.assets[sym];
  const navPre = vaultNav(vault);
  const indexPricePre = navPre / vault.supply;
  const usdAmount = rbdxIn * indexPricePre;
  const notionalTokenOut = usdAmount / asset.price;

  const curW = currentWeight(vault, sym);
  const navAfter = navPre - usdAmount;
  const nextBalanceValue = (asset.balance - notionalTokenOut) * asset.price;
  const nextW = navAfter === 0 ? 0 : nextBalanceValue / navAfter;

  const feeBps = weightFeeBps(curW, TARGET_WEIGHT[sym], nextW, VAULT_PARAMS.maxWeightFeeBps);
  const maxRebateUsd = (asset.balance - notionalTokenOut) * asset.price;
  const { effectiveUsd, reserveDelta } = applyFee(usdAmount, feeBps, maxRebateUsd, vault.rebateReserve);
  const rawTokenOut = effectiveUsd / asset.price;
  const { netAmount: tokenOut, devFeeToReserve } = splitDevFee(rawTokenOut, VAULT_PARAMS.devFeeBps, VAULT_PARAMS.rebateFundingBps);

  asset.balance -= notionalTokenOut;
  vault.rebateReserve += reserveDelta + devFeeToReserve * asset.price;
  vault.supply -= rbdxIn;
  return { tokenOut, feeBps };
}

function mostUnderweight(vault) {
  return Object.keys(vault.assets).reduce((best, sym) =>
    currentWeight(vault, sym) - TARGET_WEIGHT[sym] < currentWeight(vault, best) - TARGET_WEIGHT[best] ? sym : best,
  );
}
function mostOverweight(vault) {
  return Object.keys(vault.assets).reduce((best, sym) =>
    currentWeight(vault, sym) - TARGET_WEIGHT[sym] > currentWeight(vault, best) - TARGET_WEIGHT[best] ? sym : best,
  );
}

// ── Constant-product Uniswap pool (RBDX / USDC) ─────────────────────────────

function makePool(usdcSeed, rbdxSeed) {
  return { usdc: usdcSeed, rbdx: rbdxSeed };
}
function poolPrice(pool) {
  return pool.usdc / pool.rbdx;
}
/** Swap `amountIn` of tokenIn for tokenOut, constant-product with a fee. Mutates pool. */
function swap(pool, dir, amountIn, feeBps = UNISWAP_FEE_BPS) {
  const amountInWithFee = amountIn * (1 - feeBps / BPS);
  if (dir === "usdc->rbdx") {
    const out = (pool.rbdx * amountInWithFee) / (pool.usdc + amountInWithFee);
    pool.usdc += amountIn; pool.rbdx -= out;
    return out;
  } else {
    const out = (pool.usdc * amountInWithFee) / (pool.rbdx + amountInWithFee);
    pool.rbdx += amountIn; pool.usdc -= out;
    return out;
  }
}

// ── Scenario runner ──────────────────────────────────────────────────────

/**
 * @param shockUsd    external one-off buy (positive) or sell (negative) hitting the pool first
 * @param botCapital  bot's starting USDC
 * @param chunkUsd    bot's per-iteration trade size
 * @param reserveSeed rebateReserve at t=0 (0 = fresh mainnet launch, per today's rebateFundingBps=0 default)
 */
function runScenario({ shockUsd, botCapital, chunkUsd, reserveSeed, poolUsdcSeed = 250, poolRbdxSeed = 250 }) {
  const vault = makeVault(INITIAL_NAV, reserveSeed);
  const pool = makePool(poolUsdcSeed, poolRbdxSeed);
  const nav0 = indexPrice(vault);

  // External shock opens the gap.
  if (shockUsd > 0) swap(pool, "usdc->rbdx", shockUsd);
  else if (shockUsd < 0) swap(pool, "rbdx->usdc", -shockUsd / nav0);

  const trace = [{ iter: 0, poolPrice: poolPrice(pool), nav: indexPrice(vault), capital: botCapital, cumProfit: 0 }];
  let capital = botCapital;
  let cumProfit = 0;
  let stoppedReason = "closed";

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const nav = indexPrice(vault);
    const price = poolPrice(pool);
    const gapBps = ((price - nav) / nav) * BPS;

    if (Math.abs(gapBps) < MIN_EDGE_BPS) { stoppedReason = "closed"; break; }
    const spend = Math.min(chunkUsd, capital);
    if (spend < 1) { stoppedReason = "out-of-capital"; break; }

    let iterProfit;
    if (gapBps > 0) {
      // Premium: buy Stock Token -> mint -> sell RBDX on the pool.
      const sym = mostUnderweight(vault);
      const stockUsdAfterFriction = spend * (1 - MARKET_FRICTION_BPS / BPS);
      const { rbdxOut } = mint(vault, sym, stockUsdAfterFriction);
      const usdcOut = swap(pool, "rbdx->usdc", rbdxOut);
      iterProfit = usdcOut - spend - GAS_COST_USD;
    } else {
      // Discount: buy cheap RBDX on the pool -> redeem -> sell Stock Token.
      const rbdxBought = swap(pool, "usdc->rbdx", spend);
      const sym = mostOverweight(vault);
      const { tokenOut } = redeem(vault, sym, rbdxBought);
      const usdcOut = tokenOut * vault.assets[sym].price * (1 - MARKET_FRICTION_BPS / BPS);
      iterProfit = usdcOut - spend - GAS_COST_USD;
    }

    if (iterProfit < 0) { stoppedReason = "unprofitable"; break; }
    capital += iterProfit;
    cumProfit += iterProfit;
    trace.push({ iter: i, poolPrice: poolPrice(pool), nav: indexPrice(vault), capital, cumProfit });
  }
  if (trace.length - 1 === MAX_ITERATIONS) stoppedReason = "max-iterations";

  const last = trace[trace.length - 1];
  const gapRemainingBps = ((last.poolPrice - last.nav) / last.nav) * BPS;
  return { shockUsd, reserveSeed, iterations: trace.length - 1, stoppedReason, gapRemainingBps, cumProfit, finalCapital: capital, trace };
}

// ── Run scenarios ────────────────────────────────────────────────────────

const BOT_CAPITAL = 500;
const CHUNK = 10; // fine-grained relative to a $250/$250 pool; a real bot would size chunks adaptively
// Realistic organic trade sizes against a $250/$250 pool, plus one deliberately
// oversized "whale" trade per direction to show what happens when a single
// trade is simply too big for the pool, regardless of bot capital.
const shocks = [10, 25, 50, 100, 200, 1000 /* whale */, -10, -25, -50, -100, -200, -1000 /* whale */];
const reserveSeeds = [0, 20]; // 0 = fresh launch (today's default); 20 = manually seeded at launch

console.log(`Bot capital: $${BOT_CAPITAL} | chunk size: $${CHUNK} | pool seed: $250 USDC / $250 RBDX | market friction: ${MARKET_FRICTION_BPS}bps | gas/iter: $${GAS_COST_USD}\n`);
console.log("shock$\treserve$\titers\tstopReason\t\tgapLeft(bps)\tprofit$\tendCapital$");
const results = [];
for (const reserveSeed of reserveSeeds) {
  for (const shockUsd of shocks) {
    const r = runScenario({ shockUsd, botCapital: BOT_CAPITAL, chunkUsd: CHUNK, reserveSeed });
    results.push(r);
    console.log(
      `${shockUsd}\t${reserveSeed}\t\t${r.iterations}\t${r.stoppedReason.padEnd(14)}\t${r.gapRemainingBps.toFixed(0)}\t\t${r.cumProfit.toFixed(2)}\t${r.finalCapital.toFixed(2)}`,
    );
  }
}

// Full per-iteration trace for the headline scenarios, for charting.
const traceA = runScenario({ shockUsd: 100, botCapital: BOT_CAPITAL, chunkUsd: CHUNK, reserveSeed: 0 });
const traceB = runScenario({ shockUsd: 100, botCapital: BOT_CAPITAL, chunkUsd: CHUNK, reserveSeed: 20 });
const traceC = runScenario({ shockUsd: 1000, botCapital: BOT_CAPITAL, chunkUsd: CHUNK, reserveSeed: 0 }); // whale trade, pool-depth fragility

const fs = await import("node:fs");
fs.writeFileSync(
  new URL("./results.json", import.meta.url),
  JSON.stringify({ summary: results, traceA, traceB, traceC }, null, 2),
);
console.log("\nWrote sim/results.json (full per-iteration traces for charting).");
