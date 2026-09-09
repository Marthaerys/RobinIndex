#!/usr/bin/env node
'use strict';
// Reconstructs the RBDX index-price history from on-chain events on a 15-minute grid:
//   index price(t) = sum_i vaultBalance_i(t) * chainlinkPrice_i(t) / totalSupply(t)
// Balances come from ERC-20 Transfer logs to/from the vault, supply from RBDX mint/burn
// transfers, prices from the aggregators' AnswerUpdated logs (last update <= t), pool price
// from GeckoTerminal 15-minute candles (forward-filled).
// Differences vs the live `indexPrice()`: the vault excludes assets whose feed is stale; this
// script does not, so over weekends/holidays it shows the economic NAV rather than 0.
// Usage: node script/analytics/backfill-history.js > history.json
const L = require('./history-lib');

const GRID = 15 * 60;
const ZERO = '0x' + '0'.repeat(64);

(async () => {
  const assets = await L.loadAssets();
  const byToken = Object.fromEntries(assets.map((a) => [a.token, a]));
  const byAgg = Object.fromEntries(assets.map((a) => [a.aggregator, a]));
  const latest = parseInt(await L.rpc('eth_blockNumber', []), 16);
  const vaultTopic = L.pad32(L.VAULT);

  // 1. Stock Token transfers in/out of the vault.
  const tokens = assets.map((a) => a.token);
  const inLogs = await L.getLogs({ address: tokens, topics: [L.TOPIC_TRANSFER, null, vaultTopic], fromBlock: L.DEPLOY_BLOCK, toBlock: latest });
  const outLogs = await L.getLogs({ address: tokens, topics: [L.TOPIC_TRANSFER, vaultTopic], fromBlock: L.DEPLOY_BLOCK, toBlock: latest });
  // 2. RBDX mints and burns.
  const mints = await L.getLogs({ address: L.RBDX, topics: [L.TOPIC_TRANSFER, ZERO], fromBlock: L.DEPLOY_BLOCK, toBlock: latest });
  const burns = await L.getLogs({ address: L.RBDX, topics: [L.TOPIC_TRANSFER, null, ZERO], fromBlock: L.DEPLOY_BLOCK, toBlock: latest });
  // 3. Chainlink answers, starting ~4 days before deploy so every feed has a starting price.
  const answers = await L.getLogs({ address: assets.map((a) => a.aggregator), topics: [L.TOPIC_ANSWER_UPDATED], fromBlock: Math.max(0, L.DEPLOY_BLOCK - 3_500_000), toBlock: latest });

  // Block timestamps for the (few) blocks with transfers.
  const blocks = new Set([...inLogs, ...outLogs, ...mints, ...burns].map((l) => l.blockNumber));
  const ts = {};
  for (const b of blocks) ts[b] = parseInt((await L.rpc('eth_getBlockByNumber', [b, false])).timestamp, 16);

  const balEvents = [
    ...inLogs.map((l) => ({ t: ts[l.blockNumber], token: l.address.toLowerCase(), d: BigInt(l.data) })),
    ...outLogs.map((l) => ({ t: ts[l.blockNumber], token: l.address.toLowerCase(), d: -BigInt(l.data) })),
  ].sort((a, b) => a.t - b.t);
  const supEvents = [
    ...mints.map((l) => ({ t: ts[l.blockNumber], d: BigInt(l.data) })),
    ...burns.map((l) => ({ t: ts[l.blockNumber], d: -BigInt(l.data) })),
  ].sort((a, b) => a.t - b.t);
  // AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)
  const pxEvents = answers.map((l) => ({ t: parseInt(l.data, 16), agg: l.address.toLowerCase(), price: BigInt.asIntN(256, BigInt(l.topics[1])) })).sort((a, b) => a.t - b.t);

  // Pool price: 15-minute candles from GeckoTerminal (max 1000 per call ≈ 10 days; page back in time).
  const candles = new Map();
  try {
    let before = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 40; i++) {
      const j = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${L.POOL}/ohlcv/minute?aggregate=15&limit=1000&before_timestamp=${before}`)).json();
      const list = j.data?.attributes?.ohlcv_list || [];
      for (const [t, , , , close] of list) candles.set(t, close);
      if (list.length < 1000) break;
      before = Math.min(...list.map((c) => c[0])) - 1;
    }
  } catch { /* optional */ }

  const start = Math.floor((supEvents[0]?.t || ts[Object.keys(ts)[0]]) / GRID) * GRID;
  const now = Math.floor(Date.now() / 1000);
  const bal = {}; let supply = 0n; const px = {}; let bi = 0, si = 0, pi = 0; let lastPool = null;
  const points = [];
  for (let t = start; t <= now; t += GRID) {
    while (bi < balEvents.length && balEvents[bi].t <= t) { const e = balEvents[bi++]; bal[e.token] = (bal[e.token] || 0n) + e.d; }
    while (si < supEvents.length && supEvents[si].t <= t) supply += supEvents[si++].d;
    while (pi < pxEvents.length && pxEvents[pi].t <= t) { const e = pxEvents[pi++]; px[e.agg] = e.price; }
    if (candles.has(t)) lastPool = Number(candles.get(t));
    if (supply <= 0n) continue;
    let nav = 0n; // 1e18 * 1e8 units
    for (const [token, b] of Object.entries(bal)) { const a = byToken[token]; if (!a || b <= 0n) continue; const p = px[a.aggregator]; if (p == null) continue; nav += b * p; }
    const navUsd = Number(nav) / 1e26;
    const supplyN = Number(supply) / 1e18;
    points.push([t, +(navUsd / supplyN).toFixed(6), +navUsd.toFixed(2), +supplyN.toFixed(4), lastPool == null ? null : +lastPool.toFixed(4)]);
  }
  void byAgg;
  const out = { version: 1, updatedAt: new Date().toISOString(), source: 'backfill', points: L.compact(points) };
  process.stdout.write(JSON.stringify(out));
  console.error(`${points.length} grid points from ${new Date(start * 1000).toISOString()}; ${balEvents.length} vault transfers, ${supEvents.length} supply events, ${pxEvents.length} feed updates, ${candles.size} pool candles`);
})().catch((e) => { console.error(e); process.exit(1); });
