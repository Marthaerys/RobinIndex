import { useReadContract } from "wagmi";
import { RBDXTokenAbi } from "../abis/RBDXToken";
import { CONTRACTS } from "../config/contracts";

export function useRbdxBalance(account: `0x${string}` | undefined) {
  const { data, refetch } = useReadContract({
    address: CONTRACTS.token,
    abi: RBDXTokenAbi,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account), refetchInterval: 15_000 },
  });
  return { balance: (data as bigint | undefined) ?? 0n, refetch };
}
