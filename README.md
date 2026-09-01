# RobinIndex ($RBDX)

A market-cap-weighted index token backed by Robinhood Chain Stock Tokens, with
single-asset mint/redeem priced by a weight-deviation rebate/penalty (up to ±1%)
that incentivizes arbitrageurs to keep the basket at its target weights.

See [docs/DESIGN.md](docs/DESIGN.md) for the full mechanism spec, the researched
Robinhood Chain constraints it's built on, and the anti-drain guarantee.

## Structure

```
src/
  RBDXToken.sol       ERC-20 share token (mint/burn restricted to the vault)
  RBDXVault.sol        Core: holds the basket, mint()/redeem(), fee + rebate logic
  AssetRegistry.sol    Governance-controlled asset list + shares-outstanding
  libraries/OracleLib.sol   Chainlink read + staleness check
  interfaces/          AggregatorV3Interface, IStockToken
test/
  RBDXVault.t.sol       Unit tests, incl. the anti-drain scenario
  mocks/                MockStockToken, MockAggregator
docs/
  DESIGN.md             Full spec
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

Status: 12/12 tests passing. No deployment scripts or frontend yet — see
docs/DESIGN.md §8 for open items before mainnet.
