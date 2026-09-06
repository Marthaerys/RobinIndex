import { defineChain } from "viem";

/// Robinhood Chain Testnet — not in viem/wagmi's built-in chain list, so it's
/// defined here by hand. See docs.robinhood.com/chain/deploy-smart-contracts.
/// Kept around (unused by wagmi.ts since the mainnet launch on 2026-09-06) in
/// case testnet support/switching is wanted again later.
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

/// Robinhood Chain mainnet — live since the 2026-09-06 RBDX launch.
export const robinhoodMainnet = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
});

/// Deployed 2026-09-06 via script/DeployRBDXMainnet.s.sol. Admin on both
/// registry and vault is the 2-of-3 Safe `0x904B8B54b3734C2Bb0E26b06ab41E1d22a459eF8`,
/// not an EOA.
export const CONTRACTS = {
  token: "0x1914C83bc4E8bB36EB8eaA36f866969Fd2252030",
  registry: "0x6b61Aa9576Eb6Cbb19ac6aB350519Ac37f9CCE79",
  vault: "0xc3ce9C84E9E012A32dFf7B7B0E2d44A30A96477e",
} as const;

/// Assets listed in AssetRegistry, per script/config/assets.mainnet.json (27
/// individual-company Stock Tokens with real Chainlink Data Feeds coverage).
/// Symbols are hardcoded here for display only — the contracts themselves
/// never store a symbol, so if the listed set changes this list needs a
/// matching edit (or a future version could read `symbol()` from each token
/// on-chain instead).
export const ASSETS = [
  { symbol: "AAPL", token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" },
  { symbol: "AMD", token: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC" },
  { symbol: "AMZN", token: "0x12f190a9F9d7D37a250758b26824B97CE941bF54" },
  { symbol: "ASML", token: "0x47F93d52cBeC7C6D2CfC080e154002370a60dAEA" },
  { symbol: "BABA", token: "0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4" },
  { symbol: "CLSK", token: "0xcBB95BBF36099d34dA091dc6Fa6F49EfA257Cee3" },
  { symbol: "COIN", token: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b" },
  { symbol: "CRCL", token: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5" },
  { symbol: "CRWV", token: "0x5f10A1C971B69e47e059e1dC91901B59b3fB49C3" },
  { symbol: "GME", token: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E" },
  { symbol: "GOOGL", token: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3" },
  { symbol: "INTC", token: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681" },
  { symbol: "IONQ", token: "0x558378E000D634A36593E338eBacdd6207640EfE" },
  { symbol: "META", token: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35" },
  { symbol: "MSFT", token: "0xe93237C50D904957Cf27E7B1133b510C669c2e74" },
  { symbol: "MSTR", token: "0xec262a75e413fAfD0dF80480274532C79D42da09" },
  { symbol: "MU", token: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD" },
  { symbol: "NBIS", token: "0x9D9c6684F596F66a64C030B93A886D51Fd4D7931" },
  { symbol: "NVDA", token: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" },
  { symbol: "ORCL", token: "0xb0992820E760d836549ba69BC7598b4af75dEE03" },
  { symbol: "PLTR", token: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A" },
  { symbol: "RGTI", token: "0x284358abc07F9359f19f4b5b4aC91901Be2597Ba" },
  { symbol: "RKLB", token: "0x3b14C39E89D60D627b42a1A4CA45b5bb45Fc12e2" },
  { symbol: "SNDK", token: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400" },
  { symbol: "SPCX", token: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa" },
  { symbol: "TSLA", token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" },
  { symbol: "TSM", token: "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA" },
] as const;

export const RBDX_SYMBOL = "RBDX";
export const RBDX_DECIMALS = 18;
