'use strict';
// Shared helpers for the index-price history (backfill + 15-minute snapshots).
// No dependencies: plain JSON-RPC over fetch (Node >= 18).

const RPC = process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const VAULT = '0xc3ce9C84E9E012A32dFf7B7B0E2d44A30A96477e';
const RBDX = '0x1914C83bc4E8bB36EB8eaA36f866969Fd2252030';
const POOL = '0x6975ffdff6e01409d44c51a9fec2bb955f3d0cb3de32b2545d46cc99d190aa4b';
const DEPLOY_BLOCK = 56160228; // registry + vault, 2026-09-06
const SEL = { totalSupply: '0x18160ddd', nav: '0xc1590cd7', indexPrice: '0x10bace8c', aggregator: '0x245a7bfc' };
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TOPIC_ANSWER_UPDATED = '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f';

let rpcId = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpc(method, params, attempt = 0) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) });
  const j = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
  if (j.error) {
    // The public RPC rate-limits bursts; back off and retry a few times.
    if (attempt < 8 && /Too Many Requests|429|rate limit/i.test(j.error.message)) {
      const m = /reset in (\d+) seconds/i.exec(j.error.message);
      await sleep(m ? (Number(m[1]) + 5) * 1000 : 500 * 2 ** attempt);
      return rpc(method, params, attempt + 1);
    }
    throw new Error(`${method}: ${j.error.message}`);
  }
  await sleep(120); // stay under the public RPC's burst limit
  return j.result;
}
const call = (to, data, block = 'latest') => rpc('eth_call', [{ to, data }, block]);
const hex = (n) => '0x' + n.toString(16);
const pad32 = (addr) => '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
const toNum = (h, dec = 18) => Number(BigInt(h)) / 10 ** dec;

/** The 27 listed assets with their Chainlink aggregator (resolved live via proxy.aggregator()). */
async function loadAssets() {
  const cfg = require('../config/assets.mainnet.json');
  const out = [];
  for (const a of cfg.assets) {
    const agg = await call(a.chainlinkFeed, SEL.aggregator);
    out.push({ symbol: a.symbol, token: a.token.toLowerCase(), proxy: a.chainlinkFeed.toLowerCase(), aggregator: '0x' + agg.slice(26).toLowerCase() });
  }
  return out;
}

/** eth_getLogs in chunks (the public RPC accepts >= 1M blocks per call). */
async function getLogs({ address, topics, fromBlock, toBlock, chunk = 1_000_000 }) {
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += chunk) {
    const to = Math.min(toBlock, from + chunk - 1);
    const logs = await rpc('eth_getLogs', [{ address, topics, fromBlock: hex(from), toBlock: hex(to) }]);
    out.push(...logs);
  }
  return out;
}

/** Live sample of the vault: what the snapshot job records every 15 minutes. */
async function liveSample() {
  const [supply, nav, price] = await Promise.all([call(RBDX, SEL.totalSupply), call(VAULT, SEL.nav), call(VAULT, SEL.indexPrice)]);
  let pool = null;
  try {
    const g = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${POOL}`)).json();
    pool = Number(g.data.attributes.base_token_price_usd);
  } catch { /* pool price is optional */ }
  return { t: Math.floor(Date.now() / 1000), indexPrice: toNum(price), nav: toNum(nav), supply: toNum(supply), pool };
}

/**
 * Compact the point list so the file stays small:
 *  - last 7 days: every point (15-min samples)
 *  - 7 to 90 days: one point per hour
 *  - older: one point per day
 * Points are [t, indexPrice, nav, supply, pool|null], sorted by t.
 */
function compact(points, now = Math.floor(Date.now() / 1000)) {
  const out = [];
  let lastBucket = null;
  for (const p of points) {
    const age = now - p[0];
    const bucket = age > 90 * 86400 ? Math.floor(p[0] / 86400) : age > 7 * 86400 ? Math.floor(p[0] / 3600) : p[0];
    if (bucket === lastBucket) { out[out.length - 1] = p; continue; } // keep the last sample of the bucket
    out.push(p); lastBucket = bucket;
  }
  return out;
}

const GRID = 15 * 60;
const ZERO32 = '0x' + '0'.repeat(64);

/** Block number roughly `secondsAgo` before `latest`, from the observed block rate (Orbit blocks are irregular, so callers add margin). */
async function blockAtSecondsAgo(latest, secondsAgo) {
  const probe = Math.max(0, latest - 200_000);
  const [b1, b0] = await Promise.all([rpc('eth_getBlockByNumber', [hex(latest), false]), rpc('eth_getBlockByNumber', [hex(probe), false])]);
  const rate = (latest - probe) / Math.max(1, parseInt(b1.timestamp, 16) - parseInt(b0.timestamp, 16)); // blocks per second
  return Math.max(DEPLOY_BLOCK, Math.floor(latest - secondsAgo * rate * 1.25));
}

/**
 * Fill the 15-minute grid between the last stored point and now from on-chain events, so the
 * history does not depend on how often the snapshot job actually runs (GitHub delays cron on quiet
 * repos to every few hours). Balances at time t = current balance − transfers after t; prices = last
 * AnswerUpdated ≤ t; pool price = last GeckoTerminal 15-min close ≤ t (forward-filled).
 * Returns the new points (excluding the live sample, which the caller appends).
 */
async function gapFill(points, now = Math.floor(Date.now() / 1000)) {
  const last = points[points.length - 1];
  const lastT = last ? last[0] : now - 86400;
  const firstGrid = Math.floor(lastT / GRID) * GRID + GRID;
  const grid = [];
  for (let t = firstGrid; t <= now - 60; t += GRID) grid.push(t);
  if (grid.length === 0) return [];

  const assets = await loadAssets();
  const latest = parseInt(await rpc('eth_blockNumber', []), 16);
  const fromGap = await blockAtSecondsAgo(latest, now - lastT + 3600);
  const fromPx = await blockAtSecondsAgo(latest, now - lastT + 5 * 86400); // feeds may not have ticked for days (weekends)
  const vaultTopic = pad32(VAULT);
  const tokens = assets.map((a) => a.token);
  const [inLogs, outLogs, mints, burns, answers] = [
    await getLogs({ address: tokens, topics: [TOPIC_TRANSFER, null, vaultTopic], fromBlock: fromGap, toBlock: latest }),
    await getLogs({ address: tokens, topics: [TOPIC_TRANSFER, vaultTopic], fromBlock: fromGap, toBlock: latest }),
    await getLogs({ address: RBDX, topics: [TOPIC_TRANSFER, ZERO32], fromBlock: fromGap, toBlock: latest }),
    await getLogs({ address: RBDX, topics: [TOPIC_TRANSFER, null, ZERO32], fromBlock: fromGap, toBlock: latest }),
    await getLogs({ address: assets.map((a) => a.aggregator), topics: [TOPIC_ANSWER_UPDATED], fromBlock: fromPx, toBlock: latest }),
  ];
  const ts = {};
  for (const l of [...inLogs, ...outLogs, ...mints, ...burns]) if (!ts[l.blockNumber]) ts[l.blockNumber] = parseInt((await rpc('eth_getBlockByNumber', [l.blockNumber, false])).timestamp, 16);
  const balEv = [...inLogs.map((l) => ({ t: ts[l.blockNumber], token: l.address.toLowerCase(), d: BigInt(l.data) })), ...outLogs.map((l) => ({ t: ts[l.blockNumber], token: l.address.toLowerCase(), d: -BigInt(l.data) }))];
  const supEv = [...mints.map((l) => ({ t: ts[l.blockNumber], d: BigInt(l.data) })), ...burns.map((l) => ({ t: ts[l.blockNumber], d: -BigInt(l.data) }))];
  const pxEv = answers.map((l) => ({ t: parseInt(l.data, 16), agg: l.address.toLowerCase(), price: BigInt.asIntN(256, BigInt(l.topics[1])) })).sort((a, b) => a.t - b.t);

  // Current state (the anchor we walk back from).
  const balNow = {};
  for (const a of assets) balNow[a.token] = BigInt(await call(a.token, '0x70a08231' + VAULT.slice(2).toLowerCase().padStart(64, '0')));
  const supplyNow = BigInt(await call(RBDX, SEL.totalSupply));

  // Pool candles covering the gap.
  const candles = new Map();
  try {
    const j = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${POOL}/ohlcv/minute?aggregate=15&limit=${Math.min(1000, grid.length + 4)}`)).json();
    for (const [t, , , , close] of j.data?.attributes?.ohlcv_list || []) candles.set(t, Number(close));
  } catch { /* optional */ }

  const out = [];
  let lastPool = last ? last[4] : null;
  for (const t of grid) {
    const bal = { ...balNow };
    for (const e of balEv) if (e.t > t) bal[e.token] = (bal[e.token] || 0n) - e.d;
    let supply = supplyNow;
    for (const e of supEv) if (e.t > t) supply -= e.d;
    const px = {};
    for (const e of pxEv) if (e.t <= t) px[e.agg] = e.price;
    if (candles.has(t)) lastPool = candles.get(t);
    if (supply <= 0n) continue;
    let nav = 0n;
    for (const a of assets) { const b = bal[a.token] || 0n; const p = px[a.aggregator]; if (b > 0n && p != null) nav += b * p; }
    const navUsd = Number(nav) / 1e26;
    const supplyN = Number(supply) / 1e18;
    out.push([t, +(navUsd / supplyN).toFixed(6), +navUsd.toFixed(2), +supplyN.toFixed(4), lastPool == null ? null : +Number(lastPool).toFixed(4)]);
  }
  return out;
}

module.exports = { RPC, VAULT, RBDX, POOL, DEPLOY_BLOCK, GRID, SEL, TOPIC_TRANSFER, TOPIC_ANSWER_UPDATED, rpc, call, hex, pad32, toNum, loadAssets, getLogs, liveSample, compact, gapFill };
