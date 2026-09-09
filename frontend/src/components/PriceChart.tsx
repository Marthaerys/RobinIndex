import { useMemo, useState } from "react";
import { useHistory, type HistoryPoint } from "../hooks/useHistory";

type Range = "1D" | "1W" | "1M" | "1Y" | "ALL";
type Series = "index" | "nav";

const RANGES: { key: Range; seconds: number | null }[] = [
  { key: "1D", seconds: 86_400 },
  { key: "1W", seconds: 7 * 86_400 },
  { key: "1M", seconds: 30 * 86_400 },
  { key: "1Y", seconds: 365 * 86_400 },
  { key: "ALL", seconds: null },
];

const W = 800;
const H = 260;
const PAD = { top: 14, right: 14, bottom: 28, left: 56 };

/// Index price (NAV per RBDX) over time, with the Uniswap pool price as an optional overlay and
/// total NAV as an alternative series. Data: 15-minute samples from the `data` branch (see useHistory).
/// No 5m/1h ranges on purpose: the Chainlink equity feeds only tick on a 0.5% move or 24h heartbeat,
/// and only while the US market is open, so anything shorter than a day is a flat line.
export function PriceChart() {
  const { data, isLoading, isError } = useHistory();
  const [range, setRange] = useState<Range>("1W");
  const [series, setSeries] = useState<Series>("index");
  const [showPool, setShowPool] = useState(true);
  const [hover, setHover] = useState<number | null>(null); // index into `pts`

  const pts = useMemo(() => {
    if (!data) return [];
    const r = RANGES.find((x) => x.key === range)!;
    const cutoff = r.seconds == null ? 0 : Math.floor(Date.now() / 1000) - r.seconds;
    return data.points.filter((p) => p[0] >= cutoff);
  }, [data, range]);

  const view = useMemo(() => buildView(pts, series, showPool && series === "index"), [pts, series, showPool]);

  const last = pts[pts.length - 1];
  const first = pts[0];
  const valueOf = (p: HistoryPoint) => (series === "index" ? p[1] : p[2]);
  const change = first && last && valueOf(first) > 0 ? (valueOf(last) / valueOf(first) - 1) * 100 : null;
  const hovered = hover != null ? pts[hover] : null;

  return (
    <div className="card chart-card">
      <div className="chart-head">
        <div>
          <div className="card-title">{series === "index" ? "Index price" : "Total NAV"}</div>
          <div className="chart-headline">
            <span className="chart-value mono">
              {hovered ? fmt(valueOf(hovered), series) : last ? fmt(valueOf(last), series) : "—"}
            </span>
            {hovered ? (
              <span className="chart-sub">{fmtTime(hovered[0])}{hovered[4] != null && series === "index" ? ` · pool ${fmt(hovered[4], "index")}` : ""}</span>
            ) : change != null ? (
              <span className={`chart-sub ${change >= 0 ? "pos" : "neg"}`}>
                {change >= 0 ? "+" : ""}{change.toFixed(2)}% over {range === "ALL" ? "all time" : range}
              </span>
            ) : null}
          </div>
        </div>
        <div className="chart-controls">
          <div className="seg">
            {RANGES.map((r) => (
              <button key={r.key} className={`seg-btn ${range === r.key ? "seg-btn-active" : ""}`} onClick={() => setRange(r.key)}>{r.key}</button>
            ))}
          </div>
          <div className="seg">
            <button className={`seg-btn ${series === "index" ? "seg-btn-active" : ""}`} onClick={() => setSeries("index")}>Index price</button>
            <button className={`seg-btn ${series === "nav" ? "seg-btn-active" : ""}`} onClick={() => setSeries("nav")}>NAV</button>
          </div>
          {series === "index" && (
            <label className="chart-toggle">
              <input type="checkbox" checked={showPool} onChange={(e) => setShowPool(e.target.checked)} /> pool price
            </label>
          )}
        </div>
      </div>

      {isLoading && !data && <div className="notice">Loading history…</div>}
      {isError && !data && <div className="notice notice-warn">History unavailable right now.</div>}
      {data && pts.length < 2 && <div className="notice">Not enough samples for this range yet.</div>}

      {pts.length >= 2 && (
        <svg
          className="chart"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          onMouseMove={(e) => {
            const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const x = ((e.clientX - rect.left) / rect.width) * W;
            setHover(view.nearest(x));
          }}
          onMouseLeave={() => setHover(null)}
        >
          {view.yTicks.map((t) => (
            <g key={t.v}>
              <line x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} className="chart-grid" />
              <text x={PAD.left - 8} y={t.y + 4} textAnchor="end" className="chart-axis">{fmtAxis(t.v, series)}</text>
            </g>
          ))}
          {view.xTicks.map((t) => (
            <text key={t.t} x={t.x} y={H - 8} textAnchor="middle" className="chart-axis">{t.label}</text>
          ))}
          {view.poolPath && <path d={view.poolPath} className="chart-line chart-line-pool" />}
          <path d={view.mainPath} className="chart-line chart-line-main" />
          {hovered && hover != null && (
            <g>
              <line x1={view.x(hover)} x2={view.x(hover)} y1={PAD.top} y2={H - PAD.bottom} className="chart-cursor" />
              <circle cx={view.x(hover)} cy={view.y(valueOf(hovered))} r={4} className="chart-dot" />
            </g>
          )}
        </svg>
      )}
      <div className="chart-foot">
        <span><span className="swatch swatch-main" /> {series === "index" ? "index price = NAV / supply, from on-chain data" : "total NAV of the vault"}</span>
        {series === "index" && showPool && <span><span className="swatch swatch-pool" /> Uniswap v4 pool price</span>}
        {data && <span className="dim">updated {fmtTime(Math.floor(Date.parse(data.updatedAt) / 1000))}</span>}
      </div>
    </div>
  );
}

type View = ReturnType<typeof buildViewFor>;

function buildView(pts: HistoryPoint[], series: Series, withPool: boolean): View {
  if (pts.length < 2) {
    return { mainPath: "", poolPath: null, x: () => 0, y: () => 0, yTicks: [], xTicks: [], nearest: () => 0 };
  }
  return buildViewFor(pts, series, withPool);
}

function buildViewFor(pts: HistoryPoint[], series: Series, withPool: boolean) {
  const vals = pts.map((p) => (series === "index" ? p[1] : p[2]));
  const poolVals = withPool ? pts.map((p) => p[4]).filter((v): v is number => v != null) : [];
  let lo = Math.min(...vals, ...poolVals);
  let hi = Math.max(...vals, ...poolVals);
  if (!(hi > lo)) { lo -= 0.01; hi += 0.01; }
  const padY = (hi - lo) * 0.08;
  lo -= padY; hi += padY;
  const t0 = pts[0][0];
  const t1 = pts[pts.length - 1][0];
  const x = (i: number) => PAD.left + ((pts[i][0] - t0) / Math.max(1, t1 - t0)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);
  const path = (get: (p: HistoryPoint) => number | null) => {
    let d = "";
    let pen = false;
    pts.forEach((p, i) => {
      const v = get(p);
      if (v == null) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d;
  };
  const yTicks = niceTicks(lo, hi, 4).map((v) => ({ v, y: y(v) }));
  const xTicks = timeTicks(t0, t1, 5).map((t) => ({ t, x: PAD.left + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.left - PAD.right), label: fmtTick(t, t1 - t0) }));
  const nearest = (px: number) => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < pts.length; i++) { const d = Math.abs(x(i) - px); if (d < bestD) { bestD = d; best = i; } }
    return best;
  };
  return {
    mainPath: path((p) => (series === "index" ? p[1] : p[2])),
    poolPath: withPool ? path((p) => p[4]) : null,
    x, y, yTicks, xTicks, nearest,
  };
}

function niceTicks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(+v.toFixed(8));
  return out;
}

function timeTicks(t0: number, t1: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(Math.round(t0 + ((t1 - t0) * (i + 0.5)) / n));
  return out;
}

function fmt(v: number, series: Series) {
  return series === "index"
    ? v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 4 })
    : v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function fmtAxis(v: number, series: Series) {
  return series === "index" ? `$${v.toFixed(3)}` : v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`;
}
function fmtTime(t: number) {
  return new Date(t * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtTick(t: number, span: number) {
  const d = new Date(t * 1000);
  if (span <= 2 * 86_400) return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  if (span <= 10 * 86_400) return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
