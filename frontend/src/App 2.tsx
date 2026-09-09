import { Header } from "./components/Header";
import { StatBar } from "./components/StatBar";
import { PriceChart } from "./components/PriceChart";
import { HoldingsTable } from "./components/HoldingsTable";
import { TradePanel } from "./components/TradePanel";
import { useVaultData } from "./hooks/useVaultData";

export default function App() {
  const { data, isLoading, isError, refetch } = useVaultData();

  return (
    <div className="page">
      <Header />

      <main className="main">
        {isLoading && !data && <div className="notice">Loading on-chain data…</div>}
        {isError && <div className="notice notice-warn">Couldn't reach Robinhood Chain RPC. Retrying…</div>}

        {data && (
          <>
            {data.navIncomplete && (
              <div className="notice notice-warn">
                One or more assets the vault holds have a price feed that hasn't updated within its staleness
                window (US equity feeds stop updating while the market is closed), so those holdings are excluded
                from NAV and can't be minted or redeemed right now. The figures below understate the basket until
                the feeds refresh — see the "price feed stale" rows.
              </div>
            )}
            <StatBar data={data} />
            <PriceChart />
            <div className="layout">
              <HoldingsTable assets={data.assets} />
              <TradePanel data={data} onRefetch={refetch} />
            </div>
          </>
        )}
      </main>

      <footer className="footer">
        <nav className="footer-links" aria-label="Project links">
          <a href="https://github.com/Marthaerys/RobinIndex" target="_blank" rel="noopener noreferrer">GitHub (source + docs)</a>
          <a href="https://github.com/Marthaerys/RobinIndex/blob/main/docs/DESIGN.md" target="_blank" rel="noopener noreferrer">Mechanism design</a>
          <a href="https://robinhoodchain.blockscout.com/address/0xc3ce9C84E9E012A32dFf7B7B0E2d44A30A96477e?tab=contract" target="_blank" rel="noopener noreferrer">Vault contract (verified)</a>
          <a href="https://www.geckoterminal.com/robinhood/pools/0x6975ffdff6e01409d44c51a9fec2bb955f3d0cb3de32b2545d46cc99d190aa4b" target="_blank" rel="noopener noreferrer">RBDX/USDG pool (Uniswap v4)</a>
          <a href="https://x.com/DefiNPCMan" target="_blank" rel="noopener noreferrer">X</a>
        </nav>
        RobinIndex ($RBDX) — Robinhood Chain (4663). Experimental,
        pilot-scale project — not audited, no legal/regulatory review, not
        financial advice. Stock Tokens are not available to US persons. Use
        at your own risk.
      </footer>
    </div>
  );
}
