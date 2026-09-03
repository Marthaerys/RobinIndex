import { Header } from "./components/Header";
import { StatBar } from "./components/StatBar";
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
        {isError && <div className="notice notice-warn">Couldn't reach Robinhood Chain Testnet RPC. Retrying…</div>}

        {data && (
          <>
            <StatBar data={data} />
            <div className="layout">
              <HoldingsTable assets={data.assets} />
              <TradePanel data={data} onRefetch={refetch} />
            </div>
          </>
        )}
      </main>

      <footer className="footer">
        RobinIndex ($RBDX) — Robinhood Chain Testnet (46630). Testnet only, not financial advice.
      </footer>
    </div>
  );
}
