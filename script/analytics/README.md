# Analytics

## leaderboard.js — what Robinhood Chain actually holds

Ranks all 194 Robinhood Stock Tokens by **on-chain value = `totalSupply()` × price**. Supply is read from the token contracts over the public RPC; price comes from DefiLlama's price API (`coins.llama.fi`, chain key `robinhood`). Supply × price is the same quantity `RBDXVault` uses for its target weights (there it is supply × Chainlink price, computed on-chain for the 27 tokens that have a Data Feed).

```
node script/analytics/leaderboard.js > script/analytics/leaderboard.json
```

`leaderboard.json` is a snapshot (see its `at` field). The `feed` field says whether a token has a Chainlink Data Feed (`DataFeeds`), Data Streams only (`DataStreams`), or no Chainlink coverage (`null`).

## Index price history (the chart on robinindex.com)

- `history-lib.js` — shared RPC helpers, live sample, compaction (15-min points for 7 days, hourly to 90 days, daily beyond).
- `backfill-history.js` — reconstructs the history from on-chain events (vault Transfer logs, RBDX mint/burn, Chainlink `AnswerUpdated` on the 27 aggregators, GeckoTerminal 15-min candles for the pool price) on a 15-minute grid. Used once to seed the `data` branch; can be rerun to rebuild it. Note: it does not apply the vault's staleness exclusion, so over weekends it shows the economic NAV instead of a reduced one.
- `snapshot-history.js` — appends one live sample; run every 15 minutes by `.github/workflows/history-snapshot.yml`, which commits `history.json` to the `data` branch. The frontend (`frontend/src/hooks/useHistory.ts`) reads it from raw.githubusercontent.com.

```
node script/analytics/backfill-history.js > history.json      # rebuild from chain
node script/analytics/snapshot-history.js history.json         # append one sample
```
