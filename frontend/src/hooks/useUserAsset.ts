import { useReadContracts } from "wagmi";
import { Erc20Abi } from "../abis/Erc20";
import { CONTRACTS } from "../config/contracts";

/// Connected user's balance + vault allowance for a given stock token, plus
/// their RBDX balance. `spender` defaults to the vault (needed for mint's
/// approve step).
export function useUserAsset(tokenAddress: `0x${string}` | undefined, account: `0x${string}` | undefined) {
  const { data, refetch } = useReadContracts({
    contracts: tokenAddress && account
      ? [
          { address: tokenAddress, abi: Erc20Abi, functionName: "balanceOf", args: [account] } as const,
          { address: tokenAddress, abi: Erc20Abi, functionName: "allowance", args: [account, CONTRACTS.vault] } as const,
        ]
      : [],
    query: { enabled: Boolean(tokenAddress && account) },
  });

  const balance = (data?.[0]?.result as bigint) ?? 0n;
  const allowance = (data?.[1]?.result as bigint) ?? 0n;
  return { balance, allowance, refetch };
}
