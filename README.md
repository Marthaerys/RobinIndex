# RobinIndex ($RBDX)

An index token backed by Robinhood Chain Stock Tokens, weighted by each token's own
on-chain circulating supply (not real-world market cap — see docs/DESIGN.md §1) —
an AUM/adoption-weighted index of Robinhood Chain's tokenized-equity ecosystem.
Single-asset mint/redeem is priced by a weight-deviation rebate/penalty (up to ±1%)
that incentivizes arbitrageurs to keep the basket at its target weights, computed
live on-chain with no admin-fed data.

See [docs/DESIGN.md](docs/DESIGN.md) for the full mechanism spec, the researched
Robinhood Chain constraints it's built on, and the anti-drain guarantee.

## Status & risk disclaimer

Experimental, small-scale project. It has **not** been reviewed by a law firm
or a professional smart-contract audit firm — see [docs/DESIGN.md §8](docs/DESIGN.md)
for what's explicitly still open (regulatory review, third-party audit) and why
those were consciously deferred rather than done, given the intended
pilot-scale/single-operator launch. If this ever moves beyond that — wider
usage, active marketing, meaningfully more capital — those two items stop
being deferrable and need to happen first. Nothing here is financial or legal
advice, and interacting with any deployment of these contracts (testnet or
mainnet) is at your own risk.

## Structure

```
src/
  RBDXToken.sol       ERC-20 share token (mint/burn restricted to the vault)
  RBDXVault.sol        Core: holds the basket, mint()/redeem(), fee + rebate logic
  AssetRegistry.sol    Governance-controlled asset list; target weight computed
                        live from each token's on-chain totalSupply()
  libraries/OracleLib.sol   Chainlink read + staleness check
  interfaces/          AggregatorV3Interface, IStockToken
test/
  RBDXVault.t.sol       Unit tests, incl. the anti-drain scenario
  mocks/                MockStockToken, MockAggregator
docs/
  DESIGN.md             Full spec
frontend/
  (Vite + React + wagmi/viem dapp — holdings table + mint/redeem UI,
   deployed to GitHub Pages on every push to main, see frontend/README.md)
```

## Setup

Requires [Foundry](https://getfoundry.sh/):
```
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

Dependencies are git submodules (already vendored in this repo):
```
git submodule update --init --recursive
```

## Build & test

```
forge build
forge test -vv
```

Status: 11/11 tests passing. Deployed to Robinhood Chain Testnet (chain id
46630) with a live frontend on GitHub Pages — see docs/DESIGN.md §8 for open
items before mainnet.
