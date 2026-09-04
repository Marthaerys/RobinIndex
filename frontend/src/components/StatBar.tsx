import type { VaultData } from "../hooks/useVaultData";
import { fmtUsd, fmtToken } from "../lib/format";

export function StatBar({ data }: { data: VaultData }) {
  return (
    <div className="stat-bar">
      <Stat label="Index price" value={fmtUsd(data.indexPrice)} hint="NAV / total supply" />
      <Stat label="Total NAV" value={fmtUsd(data.nav)} hint={`${fmtToken(data.totalSupply)} RBDX outstanding`} />
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
