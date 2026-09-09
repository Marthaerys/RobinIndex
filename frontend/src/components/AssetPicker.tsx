import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetRow } from "../hooks/useVaultData";
import type { WalletHolding } from "../hooks/useWalletHoldings";
import { fmtToken, fmtUsd } from "../lib/format";

interface Option {
  index: number;
  asset: AssetRow;
  /// What this row is ranked by: the wallet's position when depositing,
  /// the vault's when redeeming.
  rankUsd: bigint;
  balance: bigint;
}

/// Asset selector for the trade panel. A bare `<select>` of 27 tickers and
/// their last prices answers a question nobody asked — the price of MSFT
/// doesn't tell you whether you own any. This lists positions instead,
/// biggest dollar value first: when depositing that's your own wallet
/// ("$203.11 · 0.85 AAPL"), when redeeming it's what the vault actually holds
/// and can therefore pay out. Assets with no position stay selectable at the
/// bottom, dimmed, so the picker is never a dead end.
export function AssetPicker({
  assets,
  value,
  onChange,
  mode,
  holdings,
  isConnected,
}: {
  assets: AssetRow[];
  value: number;
  onChange: (index: number) => void;
  mode: "mint" | "redeem";
  holdings: Map<string, WalletHolding>;
  isConnected: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = assets[value];
  const selectedHolding = selected ? holdings.get(selected.address) : undefined;
  const showWallet = mode === "mint" && isConnected;

  const options: Option[] = useMemo(() => {
    const list = assets.map((asset, index) => {
      const held = holdings.get(asset.address);
      const vaultUsd = asset.priceAvailable ? (asset.vaultBalance * asset.price) / 10n ** 18n : 0n;
      return {
        index,
        asset,
        rankUsd: showWallet ? (held?.valueUsd ?? 0n) : vaultUsd,
        balance: showWallet ? (held?.balance ?? 0n) : asset.vaultBalance,
      };
    });
    // Positions first, largest dollar value at the top; everything else falls
    // through to alphabetical so the tail stays scannable.
    return list.sort((a, b) => {
      if (a.rankUsd !== b.rankUsd) return a.rankUsd > b.rankUsd ? -1 : 1;
      if (a.balance !== b.balance) return a.balance > b.balance ? -1 : 1;
      return a.asset.symbol.localeCompare(b.asset.symbol);
    });
  }, [assets, holdings, showWallet]);

  const visible = useMemo(() => {
    const q = filter.trim().toUpperCase();
    return q ? options.filter((o) => o.asset.symbol.includes(q)) : options;
  }, [options, filter]);

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();

    function onPointerDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function pick(index: number) {
    onChange(index);
    setOpen(false);
    setFilter("");
  }

  if (!selected) return null;

  return (
    <div className="picker" ref={rootRef}>
      <button
        type="button"
        className="picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="picker-trigger-main">
          <span className="asset-symbol">{selected.symbol}</span>
          <span className="dim">
            {selected.priceAvailable ? fmtUsd(selected.price) : "price unavailable"}
          </span>
        </span>
        <span className="picker-trigger-side">
          {showWallet && selectedHolding && selectedHolding.balance > 0n && (
            <span className="mono">
              {selected.priceAvailable ? fmtUsd(selectedHolding.valueUsd) : fmtToken(selectedHolding.balance, 18, 2)}
            </span>
          )}
          <span className="picker-caret">▾</span>
        </span>
      </button>

      {open && (
        <div className="picker-pop">
          <div className="picker-head">
            {showWallet
              ? "Your wallet — largest position first"
              : mode === "mint"
                ? "Connect your wallet to rank these by what you hold"
                : "Vault holds — largest position first"}
          </div>
          <input
            ref={searchRef}
            className="input picker-search"
            type="text"
            placeholder="Filter ticker…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <ul className="picker-list" role="listbox" aria-label="Asset">
            {visible.map((o) => (
              <li key={o.asset.address}>
                <button
                  type="button"
                  role="option"
                  aria-selected={o.index === value}
                  className={`picker-option ${o.index === value ? "picker-option-active" : ""} ${
                    o.balance === 0n ? "picker-option-empty" : ""
                  }`}
                  onClick={() => pick(o.index)}
                >
                  <span className="picker-option-left">
                    <span className="asset-symbol">{o.asset.symbol}</span>
                    <span className="dim">
                      {o.balance > 0n ? `${fmtToken(o.balance, 18, 4)} ${o.asset.symbol}` : "no position"}
                    </span>
                  </span>
                  <span className="picker-option-right">
                    <span className="mono">
                      {!o.asset.priceAvailable ? "—" : o.balance > 0n ? fmtUsd(o.rankUsd) : ""}
                    </span>
                    <span className="dim">
                      {o.asset.priceAvailable ? `${fmtUsd(o.asset.price)}/sh` : "price feed stale"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {visible.length === 0 && <li className="picker-empty">No ticker matches "{filter}".</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
