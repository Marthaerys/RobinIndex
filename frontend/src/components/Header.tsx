import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { robinhoodMainnet } from "../config/contracts";
import { shortAddr } from "../lib/format";

export function Header() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  const wrongNetwork = isConnected && chainId !== robinhoodMainnet.id;

  return (
    <header className="header">
      <div className="header-brand">
        <span className="brand-mark">◆</span>
        <div>
          <div className="brand-name">RobinIndex</div>
          <div className="brand-ticker">$RBDX</div>
        </div>
      </div>

      <div className="header-actions">
        {wrongNetwork && (
          <button className="btn btn-warn" onClick={() => switchChain({ chainId: robinhoodMainnet.id })} disabled={isSwitching}>
            {isSwitching ? "Switching…" : "Wrong network — switch"}
          </button>
        )}

        {isConnected && address ? (
          <button className="btn btn-ghost" onClick={() => disconnect()}>
            {shortAddr(address)}
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={() => connect({ connector: connectors[0] })}
            disabled={isPending || connectors.length === 0}
          >
            {isPending ? "Connecting…" : connectors.length === 0 ? "No wallet found" : "Connect wallet"}
          </button>
        )}
      </div>
    </header>
  );
}
