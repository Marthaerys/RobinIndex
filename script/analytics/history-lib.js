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

module.exports = { RPC, VAULT, RBDX, POOL, DEPLOY_BLOCK, SEL, TOPIC_TRANSFER, TOPIC_ANSWER_UPDATED, rpc, call, hex, pad32, toNum, loadAssets, getLogs, liveSample, compact };
