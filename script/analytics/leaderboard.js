#!/usr/bin/env node
'use strict';
// Ranks all Robinhood Stock Tokens by on-chain value = totalSupply() × price.
// Addresses: script/config/robinhood_stock_tokens_top100.json (top100 + remaining94).
// Usage: node script/analytics/leaderboard.js > script/analytics/leaderboard.json
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const cfg = require('../config/robinhood_stock_tokens_top100.json');
const tokens = [...cfg.top100, ...cfg.remaining94];

async function supply(addr) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: addr, data: '0x18160ddd' }, 'latest'] }) });
  const j = await r.json();
  return j.result ? Number(BigInt(j.result)) / 1e18 : null;
}

async function prices(addrs) {
  const out = {};
  for (let i = 0; i < addrs.length; i += 40) {
    const chunk = addrs.slice(i, i + 40).map((a) => 'robinhood:' + a).join(',');
    const j = await (await fetch('https://coins.llama.fi/prices/current/' + chunk)).json();
    for (const [k, v] of Object.entries(j.coins || {})) out[k.split(':')[1].toLowerCase()] = v;
  }
  return out;
}

(async () => {
  const px = await prices(tokens.map((t) => t.address));
  const rows = [];
  for (const t of tokens) {
    const s = await supply(t.address);
    const p = px[t.address.toLowerCase()];
    rows.push({
      symbol: t.symbol, name: t.name, address: t.address,
      supply: s, price: p?.price ?? null, priceConfidence: p?.confidence ?? null,
      feed: t.chainlinkFeed?.product || null,
      usd: s != null && p ? s * p.price : null,
    });
  }
  rows.sort((a, b) => (b.usd || 0) - (a.usd || 0));
  const totalUsd = rows.reduce((x, r) => x + (r.usd || 0), 0);
  const priced = rows.filter((r) => r.usd != null).length;
  console.log(JSON.stringify({ at: new Date().toISOString(), tokens: rows.length, priced, totalUsd, rows }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
