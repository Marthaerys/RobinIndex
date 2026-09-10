#!/usr/bin/env node
'use strict';
// Appends one live sample to history.json (run every 15 minutes by .github/workflows/history-snapshot.yml).
// Usage: node script/analytics/snapshot-history.js <path/to/history.json>
const fs = require('node:fs');
const L = require('./history-lib');

(async () => {
  const file = process.argv[2];
  if (!file) throw new Error('usage: snapshot-history.js <history.json>');
  const hist = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, points: [] };
  // 1. Fill the 15-minute grid since the last point from on-chain events (GitHub's cron is best-effort).
  let filled = [];
  try { filled = await L.gapFill(hist.points); } catch (e) { console.warn('gap fill skipped:', e.message); }
  hist.points.push(...filled);
  // 2. Append the live sample.
  const s = await L.liveSample();
  const last = hist.points[hist.points.length - 1];
  if (last && s.t - last[0] < 60) { console.log('sample too close to the previous one, skipping'); return; }
  hist.points.push([s.t, +s.indexPrice.toFixed(6), +s.nav.toFixed(2), +s.supply.toFixed(4), s.pool == null ? null : +s.pool.toFixed(4)]);
  hist.points.sort((a, b) => a[0] - b[0]);
  console.log(`gap fill: ${filled.length} points`);
  hist.points = L.compact(hist.points, s.t);
  hist.updatedAt = new Date(s.t * 1000).toISOString();
  hist.source = 'snapshot';
  fs.writeFileSync(file, JSON.stringify(hist));
  console.log(`appended ${new Date(s.t * 1000).toISOString()} index=${s.indexPrice.toFixed(4)} nav=${s.nav.toFixed(2)} supply=${s.supply.toFixed(2)} pool=${s.pool} → ${hist.points.length} points`);
})().catch((e) => { console.error(e); process.exit(1); });
