import { useReadContracts } from "wagmi";
import type { Abi } from "viem";
import { ASSETS, CONTRACTS } from "../config/contracts";
import { RBDXVaultAbi } from "../abis/RBDXVault";
import { RBDXTokenAbi } from "../abis/RBDXToken";
import { AssetRegistryAbi } from "../abis/AssetRegistry";
import { Erc20Abi } from "../abis/Erc20";

const vault = { address: CONTRACTS.vault, abi: RBDXVaultAbi } as const;
const registry = { address: CONTRACTS.registry, abi: AssetRegistryAbi } as const;
const token = { address: CONTRACTS.token, abi: RBDXTokenAbi } as const;

export interface AssetRow {
  symbol: string;
  address: `0x${string}`;
  price: bigint;
  targetWeight: bigint;
  vaultBalance: bigint;
  currentWeight: bigint; // computed client-side vs. nav
}

export interface VaultData {
  nav: bigint;
  totalSupply: bigint;
  indexPrice: bigint;
  rebateReserve: bigint;
  devFeeBps: bigint;
  rebateFundingBps: bigint;
  maxWeightFeeBps: bigint;
  mintRedeemCooldown: bigint;
  assets: AssetRow[];
}

/// Batched (multicall3) read of everything the holdings table + mint/redeem
/// preview needs. Polls every 15s so premium/discount figures stay live
/// without the user refreshing.
export function useVaultData() {
  // Deliberately untyped as a heterogeneous call list (functionName widened to
  // `string`) rather than fought into one literal tuple across three
  // different ABIs — every result below is read back with an explicit cast
  // anyway, so wagmi's per-call result inference buys nothing here.
  const assetCalls: { address: `0x${string}`; abi: Abi; functionName: string; args: unknown[] }[] =
    ASSETS.flatMap((a) => [
      { ...registry, functionName: "priceOf", args: [a.token] },
      { ...registry, functionName: "targetWeightOf", args: [a.token] },
      { ...Erc20Abi_contract(a.token), functionName: "balanceOf", args: [CONTRACTS.vault] },
    ]);

  const { data, isLoading, isError, refetch } = useReadContracts({
    contracts: [
      { ...vault, functionName: "nav", args: [] },
      { ...token, functionName: "totalSupply", args: [] },
      { ...vault, functionName: "indexPrice", args: [] },
      { ...vault, functionName: "rebateReserve", args: [] },
      { ...vault, functionName: "devFeeBps", args: [] },
      { ...vault, functionName: "rebateFundingBps", args: [] },
      { ...vault, functionName: "maxWeightFeeBps", args: [] },
      { ...vault, functionName: "mintRedeemCooldown", args: [] },
      ...assetCalls,
    ],
    query: { refetchInterval: 15_000 },
  });

  let parsed: VaultData | undefined;
  if (data) {
    const [navR, supplyR, indexPriceR, reserveR, devFeeR, rebateFundingR, maxWeightR, cooldownR, ...assetR] = data;
    const nav = (navR.result as bigint) ?? 0n;
    const totalSupply = (supplyR.result as bigint) ?? 0n;

    const assets: AssetRow[] = ASSETS.map((a, i) => {
      const price = (assetR[i * 3]?.result as bigint) ?? 0n;
      const targetWeight = (assetR[i * 3 + 1]?.result as bigint) ?? 0n;
      const vaultBalance = (assetR[i * 3 + 2]?.result as bigint) ?? 0n;
      const value = (vaultBalance * price) / 10n ** 18n;
      const currentWeight = nav === 0n ? 0n : (value * 10n ** 18n) / nav;
      return { symbol: a.symbol, address: a.token, price, targetWeight, vaultBalance, currentWeight };
    });

    parsed = {
      nav,
      totalSupply,
      indexPrice: (indexPriceR.result as bigint) ?? 0n,
      rebateReserve: (reserveR.result as bigint) ?? 0n,
      devFeeBps: (devFeeR.result as bigint) ?? 0n,
      rebateFundingBps: (rebateFundingR.result as bigint) ?? 0n,
      maxWeightFeeBps: (maxWeightR.result as bigint) ?? 0n,
      mintRedeemCooldown: (cooldownR.result as bigint) ?? 0n,
      assets,
    };
  }

  return { data: parsed, isLoading, isError, refetch };
}

function Erc20Abi_contract(address: `0x${string}`) {
  return { address, abi: Erc20Abi } as const;
}
