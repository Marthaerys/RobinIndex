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
script/
  DeployRBDX.s.sol         Testnet deploy (mock Chainlink feeds — real ones
                            don't exist on Robinhood Chain testnet)
  DeployRBDXMainnet.s.sol  Mainnet deploy — lists real Stock Tokens against
                            their real Chainlink Data Feeds, no mocks
  config/assets.mainnet.json  The 27-asset mainnet launch list (individual
                            Stock Tokens only — see that file's header for
                            the full selection rationale)
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

Status: 20/20 tests passing.

## Live on Robinhood Chain mainnet (since 2026-09-06)

| | |
|---|---|
| App | [robinindex.com](https://robinindex.com/) |
| Chain | Robinhood Chain, id 4663, RPC `https://rpc.mainnet.chain.robinhood.com` |
| RBDXToken | [`0x1914C83bc4E8bB36EB8eaA36f866969Fd2252030`](https://robinhoodchain.blockscout.com/address/0x1914C83bc4E8bB36EB8eaA36f866969Fd2252030?tab=contract) (verified) |
| RBDXVault | [`0xc3ce9C84E9E012A32dFf7B7B0E2d44A30A96477e`](https://robinhoodchain.blockscout.com/address/0xc3ce9C84E9E012A32dFf7B7B0E2d44A30A96477e?tab=contract) (verified) |
| AssetRegistry | [`0x6b61Aa9576Eb6Cbb19ac6aB350519Ac37f9CCE79`](https://robinhoodchain.blockscout.com/address/0x6b61Aa9576Eb6Cbb19ac6aB350519Ac37f9CCE79?tab=contract) (verified) |
| Admin | 2-of-3 Safe `0x904B8B54b3734C2Bb0E26b06ab41E1d22a459eF8` |
| DEX | [RBDX/USDG 0.25% on Uniswap v4](https://www.geckoterminal.com/robinhood/pools/0x6975ffdff6e01409d44c51a9fec2bb955f3d0cb3de32b2545d46cc99d190aa4b) |
| Assets | 27 individual-company Stock Tokens, see `script/config/assets.mainnet.json` |
| Launch thread | [x.com/DefiNPCMan](https://x.com/DefiNPCMan/status/2097310065359294702) |

### Try it (non-US persons only)

1. Add Robinhood Chain to your wallet (chain id 4663) and hold a listed Stock Token
   (buy one on Uniswap on Robinhood Chain, or move one from Robinhood Wallet).
2. Open [robinindex.com](https://robinindex.com/), connect, pick the asset, enter an
   amount. The panel shows the exact discount/penalty and RBDX out before you sign;
   depositing an *underweight* asset (anything the vault holds little of) earns a rebate.
3. Redeem the same way in reverse, into any listed asset. RBDX is a plain ERC-20 and
   also trades on Uniswap.

Pilot scale: read the [status & risk disclaimer](#status--risk-disclaimer) and
docs/DESIGN.md §8 (open items: third-party audit, legal review, after-hours oracle
trade-off) before putting in anything you can't afford to lose.
