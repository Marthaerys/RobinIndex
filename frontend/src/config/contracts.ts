import { defineChain } from "viem";

/// Robinhood Chain Testnet — not in viem/wagmi's built-in chain list, so it's
/// defined here by hand. See docs.robinhood.com/chain/deploy-smart-contracts.
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.chain.robinhood.com/rpc"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://explorer.testnet.chain.robinhood.com",
    },
  },
  testnet: true,
});

/// Deployed 2026-09-02 via script/DeployRBDX.s.sol. Addresses stay stable
/// across the asset re-listing done on 2026-09-03 (delist+addAsset doesn't
/// touch these).
export const CONTRACTS = {
  token: "0x16e5a63affb0a5eEdC67E9Fc11Bcaa3c0Ec3a801",
  registry: "0x1914C83bc4E8bB36EB8eaA36f866969Fd2252030",
  vault: "0x6b61Aa9576Eb6Cbb19ac6aB350519Ac37f9CCE79",
} as const;

/// Assets listed in AssetRegistry, per script/config/assets.testnet.json.
/// Symbols are hardcoded here for display only — the contracts themselves
/// never store a symbol, so if the listed set changes this list needs a
/// matching edit (or a future version could read `symbol()` from each token
/// on-chain instead).
export const ASSETS = [
  { symbol: "TSLA", token: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E" },
  { symbol: "AMZN", token: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02" },
  { symbol: "PLTR", token: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0" },
  { symbol: "NFLX", token: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93" },
  { symbol: "AMD", token: "0x71178BAc73cBeb415514eB542a8995b82669778d" },
] as const;

export const RBDX_SYMBOL = "RBDX";
export const RBDX_DECIMALS = 18;
