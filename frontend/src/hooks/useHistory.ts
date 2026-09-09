import { useQuery } from "@tanstack/react-query";

/// One sample: [unix seconds, index price (USD/RBDX), total NAV (USD), RBDX supply, pool price (USD) | null]
export type HistoryPoint = [number, number, number, number, number | null];

export interface History {
  version: number;
  updatedAt: string;
  points: HistoryPoint[];
}

/// Written every 15 minutes by .github/workflows/history-snapshot.yml to the `data` branch;
/// backfilled from on-chain events by script/analytics/backfill-history.js.
const HISTORY_URL = "https://raw.githubusercontent.com/Marthaerys/RobinIndex/data/history.json";

export function useHistory() {
  return useQuery({
    queryKey: ["history"],
    queryFn: async (): Promise<History> => {
      // raw.githubusercontent caches ~5 min; the bucket param makes sure a new sample shows up.
      const bucket = Math.floor(Date.now() / (5 * 60_000));
      const r = await fetch(`${HISTORY_URL}?t=${bucket}`);
      if (!r.ok) throw new Error(`history ${r.status}`);
      return r.json();
    },
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
}
