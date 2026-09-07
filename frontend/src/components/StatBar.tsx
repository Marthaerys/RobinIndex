import type { VaultData } from "../hooks/useVaultData";
import { fmtUsd, fmtToken } from "../lib/format";

export function StatBar({ data }: { data: VaultData }) {
  // With a stale feed on a held asset, `_nav()` silently drops that holding, so
  // both NAV and the index price derived from it are a lower bound, not a
  // figure — and in the degenerate all-stale case they read "$0.00", which
  // states the basket is empty. Show them as unavailable instead; the banner in
  // App explains why.
  const navKnown = !data.navIncomplete;

  return (
    <div className="stat-bar">
      <Stat
        label="Index price"
        value={navKnown ? fmtUsd(data.indexPrice) : "—"}
        hint={navKnown ? "NAV / total supply" : "unavailable — stale price feed"}
      />
      <Stat
        label="Total NAV"
        value={navKnown ? fmtUsd(data.nav) : "—"}
        hint={navKnown ? `${fmtToken(data.totalSupply)} RBDX outstanding` : `${fmtToken(data.totalSupply)} RBDX outstanding · stale price feed`}
      />
      <Stat label="Rebate reserve" value={fmtUsd(data.rebateReserve)} hint="funds discount payouts" />
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}
