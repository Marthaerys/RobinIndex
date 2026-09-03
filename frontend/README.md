# RobinIndex frontend

Vite + React + TypeScript, wired via wagmi/viem directly to the RBDX
contracts on **Robinhood Chain Testnet** (chain id 46630). No backend — the
dapp reads/writes the chain straight from the browser. Deployed to GitHub
Pages on every push to `main` that touches `frontend/` (see
`.github/workflows/deploy-frontend.yml`).

## What it does

- **Holdings table** — every listed Stock Token's current weight in the vault
  vs. its on-chain target weight (see `docs/DESIGN.md` for what "target
  weight" means here — it's `totalSupply() × price`, not real-world market
  cap).
- **Trade panel** — connect a wallet (any injected EIP-1193 provider, e.g.
  MetaMask) to mint RBDX against a Stock Token, or redeem RBDX back into one.
  Before you submit, it shows a live preview of the weight-deviation
  discount/penalty and the expected output — computed client-side in
  `src/lib/math.ts`, a line-for-line port of `RBDXVault.sol`'s
  `_weightFeeBps` / `_applyFee` / `_splitDevFee`, using freshly-read on-chain
  state. It's a preview, not a guarantee — the real tx still carries its own
  slippage-guarded `minOut`.

## Dev

```bash
cd frontend
npm install
npm run dev       # http://localhost:5173/RobinIndex/
npm run build     # type-checks + production build to dist/
```

## Config

Contract addresses, the asset list, and the chain definition live in
`src/config/contracts.ts`. If assets are re-listed or contracts are
redeployed, that's the one file to update — everything else reads from it or
from chain.

## Known limitation

`src/config/contracts.ts` hardcodes each Stock Token's display symbol next to
its address (the contracts themselves never store a symbol). If the listed
asset set changes, update that list by hand.
