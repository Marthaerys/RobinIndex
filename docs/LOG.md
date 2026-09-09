
### 11:30–12:15 UTC — Prijsgrafiek voor robinindex.com (verzoek gebruiker) → PR #5
- Advies: indexprijs (NAV per RBDX) als hoofdlijn, poolprijs als overlay, totale NAV als alternatief; bereiken 1D/1W/1M/1Y/ALL, geen 5m/1h (feeds tikken alleen bij 0,5% afwijking / 24u heartbeat tijdens beurstijden). Plaatsing direct onder de stat-bar, boven de samenstelling.
- Publieke RPC is geen archive-node (historische eth_call faalt na ~1000 blokken), wel eth_getLogs over 1M blokken. Oplossing: GitHub Action elke 15 min → `history.json` op branch `data` (aangemaakt en gevuld) → frontend leest via raw.githubusercontent. Backfill uit Transfer/mint-burn/AnswerUpdated-events + GeckoTerminal-candles: 264 punten sinds 06-09 18:00 UTC, indexprijs $1,0000 → $1,0077 (08-09) → $0,990 (nu).
- RPC rate-limit ("reset in 60 seconds") → retry/backoff in history-lib.js. Eerste render crashte op lege data (pts[0]) → guard. Build + headless-screenshot gecontroleerd.
- PR: https://github.com/Marthaerys/RobinIndex/pull/5. Cron start pas na merge (default branch). Scripts in script/analytics/ (README bijgewerkt).
