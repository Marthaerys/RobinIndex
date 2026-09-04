import { useMemo, useState } from "react";
import type { AssetRow } from "../hooks/useVaultData";
import { fmtToken, fmtUsd, fmtPct } from "../lib/format";

type SortKey = "asset" | "price" | "value" | "weight" | "deviation";
type SortDir = "asc" | "desc";

interface Row {
  asset: AssetRow;
  current: number;
  target: number;
  /// Signed percentage points: negative = underweight (biggest mint discount),
  /// positive = overweight (biggest mint penalty / redeem discount).
  deltaPp: number;
  valueUsd: bigint;
}

/// ETF-style factsheet: current holding weight vs. the on-chain target weight
/// (= each Stock Token's own totalSupply × price, see AssetRegistry.sol) for
/// every listed asset. The gap between the two columns is exactly what
/// drives the mint/redeem discount or penalty in the trade panel — sortable by
/// "Discount / penalty" so the biggest opportunity is a click away.
export function HoldingsTable({ assets }: { assets: AssetRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const rows: Row[] = useMemo(
    () =>
      assets.map((a) => {
        const current = Number(a.currentWeight) / 1e18;
        const target = Number(a.targetWeight) / 1e18;
        return {
          asset: a,
          current,
          target,
          deltaPp: (current - target) * 100,
          valueUsd: (a.vaultBalance * a.price) / 10n ** 18n,
        };
      }),
    [assets],
  );

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const dir = sortDir === "asc" ? 1 : -1;
    const cmp: Record<SortKey, (a: Row, b: Row) => number> = {
      asset: (a, b) => a.asset.symbol.localeCompare(b.asset.symbol),
      price: (a, b) => (a.asset.price < b.asset.price ? -1 : a.asset.price > b.asset.price ? 1 : 0),
      value: (a, b) => (a.valueUsd < b.valueUsd ? -1 : a.valueUsd > b.valueUsd ? 1 : 0),
      weight: (a, b) => a.current - b.current,
      deviation: (a, b) => a.deltaPp - b.deltaPp,
    };
    return [...rows].sort((a, b) => dir * cmp[sortKey](a, b));
  }, [rows, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortKey(key);
    // "Deviation" defaults to ascending so the first click surfaces the most
    // underweight asset (biggest current mint discount) first — that's what
    // people come here looking for. Every other column defaults to descending
    // (biggest-first reads more naturally for price/value/weight).
    setSortDir(key === "deviation" ? "asc" : "desc");
  }

  return (
    <div className="card">
      <div className="card-title">Index composition</div>
      <table className="holdings">
        <thead>
          <tr>
            <SortHeader label="Asset" col="asset" sortKey={sortKey} dir={sortDir} onSort={handleSort} />
            <SortHeader label="Price" col="price" sortKey={sortKey} dir={sortDir} onSort={handleSort} />
            <SortHeader label="Vault holds" col="value" sortKey={sortKey} dir={sortDir} onSort={handleSort} />
            <SortHeader label="Weight" col="weight" sortKey={sortKey} dir={sortDir} onSort={handleSort} />
            <SortHeader label="Discount / penalty" col="deviation" sortKey={sortKey} dir={sortDir} onSort={handleSort} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <HoldingRow key={row.asset.address} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortHeader({
  label,
  col,
  sortKey,
  dir,
  onSort,
}: {
  label: string;
  col: SortKey;
  sortKey: SortKey | null;
  dir: SortDir;
  onSort: (col: SortKey) => void;
}) {
  const active = sortKey === col;
  return (
    <th className="sortable-th" onClick={() => onSort(col)} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      {label}
      <span className={`sort-arrow ${active ? "sort-arrow-active" : ""}`}>{active ? (dir === "asc" ? "▲" : "▼") : "⇅"}</span>
    </th>
  );
}

function HoldingRow({ row }: { row: Row }) {
  const { asset, current, target, deltaPp, valueUsd } = row;
  const overweight = deltaPp > 0.05;
  const underweight = deltaPp < -0.05;

  return (
    <tr>
      <td className="asset-cell">
        <span className="asset-symbol">{asset.symbol}</span>
      </td>
      <td className="mono">{fmtUsd(asset.price)}</td>
      <td className="mono">
        {fmtToken(asset.vaultBalance, 18, 2)}
        <span className="dim"> · {fmtUsd(valueUsd)}</span>
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
