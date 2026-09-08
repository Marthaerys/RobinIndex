# Analytics

## leaderboard.js — what Robinhood Chain actually holds

Ranks all 194 Robinhood Stock Tokens by **on-chain value = `totalSupply()` × price**. Supply is read from the token contracts over the public RPC; price comes from DefiLlama's price API (`coins.llama.fi`, chain key `robinhood`). Supply × price is the same quantity `RBDXVault` uses for its target weights (there it is supply × Chainlink price, computed on-chain for the 27 tokens that have a Data Feed).

```
node script/analytics/leaderboard.js > script/analytics/leaderboard.json
```

`leaderboard.json` is a snapshot (see its `at` field). The `feed` field says whether a token has a Chainlink Data Feed (`DataFeeds`), Data Streams only (`DataStreams`), or no Chainlink coverage (`null`).
