import { useReadContract } from "wagmi";
import { RBDXVaultAbi } from "../abis/RBDXVault";
import { CONTRACTS } from "../config/contracts";

export function useRedeemCooldown(account: `0x${string}` | undefined) {
  const { data, refetch } = useReadContract({
    address: CONTRACTS.vault,
    abi: RBDXVaultAbi,
    functionName: "mintCooldownEnds",
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account), refetchInterval: 5_000 },
  });
  const cooldownEnds = (data as bigint | undefined) ?? 0n;
  return { cooldownEnds, refetch };
}
