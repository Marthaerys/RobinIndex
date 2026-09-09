import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import type { AssetRow } from "./useVaultData";
import { Erc20Abi } from "../abis/Erc20";

export interface WalletHolding {
  balance: bigint;
  /// Wallet balance priced at the registry's current price, 18 decimals.
  /// 0n whenever the asset's feed is stale (`priceAvailable === false`), so
  /// callers must check that flag before presenting this as "worth $0".
  valueUsd: bigint;
}

/// Every listed Stock Token's balance for the connected wallet, in one
/// multicall — what the asset picker needs to rank "what can I actually
/// deposit" by size instead of by registry order. Keyed by token address so
/// the caller can look up rows regardless of how it sorts them.
export function useWalletHoldings(assets: AssetRow[], account: `0x${string}` | undefined) {
  const enabled = Boolean(account) && assets.length > 0;

  const { data, refetch } = useReadContracts({
    contracts: enabled
      ? assets.map((a) => ({
          address: a.address,
          abi: Erc20Abi,
          functionName: "balanceOf",
          args: [account!],
        }))
      : [],
    // Same 15s cadence as useVaultData, so the picker's dollar figures move
    // together with the prices they were computed from.
    query: { enabled, refetchInterval: 15_000 },
  });

  const holdings = useMemo(() => {
    const map = new Map<string, WalletHolding>();
    assets.forEach((a, i) => {
      const balance = (data?.[i]?.result as bigint) ?? 0n;
      map.set(a.address, {
        balance,
        valueUsd: a.priceAvailable ? (balance * a.price) / 10n ** 18n : 0n,
      });
    });
    return map;
  }, [assets, data]);

  return { holdings, refetch };
}
