import type { AssetRow } from "../hooks/useVaultData";
import { fmtToken, fmtUsd, fmtPct } from "../lib/format";

/// ETF-style factsheet: current holding weight vs. the on-chain target weight
/// (= each Stock Token's own totalSupply × price, see AssetRegistry.sol) for
/// every listed asset. The gap between the two columns is exactly what
/// drives the mint/redeem discount or penalty in the trade panel.
export function HoldingsTable({ assets }: { assets: AssetRow[] }) {
  return (
    <div className="card">
      <div className="card-title">Index composition</div>
      <table className="holdings">
        <thead>
          <tr>
            <th>Asset</th>
            <th>Price</th>
            <th>Vault holds</th>
            <th>Weight</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {assets.map((a) => (
            <HoldingRow key={a.address} asset={a} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HoldingRow({ asset }: { asset: AssetRow }) {
  const current = Number(asset.currentWeight) / 1e18;
  const target = Number(asset.targetWeight) / 1e18;
  const deltaPp = (current - target) * 100;
  const overweight = deltaPp > 0.05;
  const underweight = deltaPp < -0.05;
  const value = (asset.vaultBalance * asset.price) / 10n ** 18n;

  return (
    <tr>
      <td className="asset-cell">
        <span className="asset-symbol">{asset.symbol}</span>
      </td>
      <td className="mono">{fmtUsd(asset.price)}</td>
      <td className="mono">
        {fmtToken(asset.vaultBalance, 18, 2)}
        <span className="dim"> · {fmtUsd(value)}</span>
      </td>
      <td className="weight-cell">
        <div className="weight-bar-row">
          <span className="mono">{fmtPct(asset.currentWeight)}</span>
          <span className="dim">/ {fmtPct(asset.targetWeight)} target</span>
        </div>
        <div className="weight-bar">
          <div className="weight-bar-fill" style={{ width: `${Math.min(current * 100, 100)}%` }} />
          <div className="weight-bar-target" style={{ left: `${Math.min(target * 100, 100)}%` }} />
        </div>
      </td>
      <td>
        {(overweight || underweight) && (
          <span className={`badge ${overweight ? "badge-over" : "badge-under"}`}>
            {overweight ? "▲" : "▼"} {Math.abs(deltaPp).toFixed(1)}pp
          </span>
        )}
      </td>
    </tr>
  );
}
