import type { ChartPanelProps, ChartPoint, ChartSeries } from "@tng/shared";

/**
 * LCARS chart panel: line / bar / pie, rendered as pure SVG — no libraries,
 * so the wall stays self-contained and every mark uses the LCARS palette.
 * Data arrives fully prepared in props; this component only draws.
 */

const COLORS = [
  "var(--lcars-gold)",
  "var(--lcars-lavender)",
  "var(--lcars-blue)",
  "var(--lcars-peach)",
  "var(--lcars-cream)",
  "var(--lcars-red)",
];

const W = 1000;
const H = 540;
const M = { l: 95, r: 30, t: 20, b: 70 };

function formatValue(v: number, unit?: string): string {
  const abs = Math.abs(v);
  let s: string;
  if (abs >= 1e9) s = `${+(v / 1e9).toFixed(1)}B`;
  else if (abs >= 1e6) s = `${+(v / 1e6).toFixed(1)}M`;
  else if (abs >= 1e4) s = `${+(v / 1e3).toFixed(1)}k`;
  else if (Number.isInteger(v)) s = String(v);
  else s = v.toFixed(abs < 10 ? 2 : 1);
  if (!unit) return s;
  return unit === "$" || unit === "€" || unit === "£" ? `${unit}${s}` : `${s}${unit}`;
}

/** Round tick steps to 1/2/5×10ⁿ so axis labels come out human. */
function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (lo === hi) hi = lo === 0 ? 1 : lo + Math.abs(lo) * 0.1;
  const step0 = (hi - lo) / (count - 1);
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  const step = (norm > 5 ? 10 : norm > 2 ? 5 : norm > 1 ? 2 : 1) * mag;
  const start = Math.floor(lo / step) * step;
  const ticks: number[] = [];
  for (let t = start; t <= hi + step / 2; t += step) ticks.push(+t.toPrecision(12));
  return ticks;
}

/** At most `max` evenly spaced label indices, always including first + last. */
function sampleIndices(n: number, max: number): Set<number> {
  if (n <= max) return new Set(Array.from({ length: n }, (_, i) => i));
  const idx = new Set<number>();
  for (let i = 0; i < max; i++) idx.add(Math.round((i * (n - 1)) / (max - 1)));
  return idx;
}

function LineChart({ series, unit }: { series: ChartSeries[]; unit?: string }) {
  const all = series.flatMap((s) => s.points.map((p) => p.value));
  const ticks = niceTicks(Math.min(...all), Math.max(...all));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const n = Math.max(...series.map((s) => s.points.length));
  const x = (i: number) => M.l + (n <= 1 ? 0 : (i * (W - M.l - M.r)) / (n - 1));
  const y = (v: number) => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);
  const labels = series.reduce((best, s) => (s.points.length > best.length ? s.points : best), [] as ChartPoint[]);
  const shown = sampleIndices(labels.length, 8);

  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {ticks.map((t) => (
        <g key={t}>
          <line className="chart-grid" x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} />
          <text className="chart-tick" x={M.l - 12} y={y(t) + 6} textAnchor="end">
            {formatValue(t, unit)}
          </text>
        </g>
      ))}
      {labels.map((p, i) =>
        shown.has(i) ? (
          <text key={i} className="chart-tick" x={x(i)} y={H - M.b + 30} textAnchor="middle">
            {p.label}
          </text>
        ) : null,
      )}
      <line className="chart-axis" x1={M.l} x2={M.l} y1={M.t} y2={H - M.b} />
      <line className="chart-axis" x1={M.l} x2={W - M.r} y1={H - M.b} y2={H - M.b} />
      {series.map((s, si) => (
        <g key={si}>
          <polyline
            className="chart-line"
            points={s.points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")}
            style={{ stroke: COLORS[si % COLORS.length] }}
          />
          {s.points.length === 1 && (
            <circle cx={x(0)} cy={y(s.points[0].value)} r={7} fill={COLORS[si % COLORS.length]} />
          )}
        </g>
      ))}
    </svg>
  );
}

function BarChart({ points, unit }: { points: ChartPoint[]; unit?: string }) {
  const ticks = niceTicks(Math.min(0, ...points.map((p) => p.value)), Math.max(0, ...points.map((p) => p.value)));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const y = (v: number) => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);
  const slot = (W - M.l - M.r) / points.length;
  const bw = slot * 0.62;
  const shown = sampleIndices(points.length, 12);

  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {ticks.map((t) => (
        <g key={t}>
          <line className="chart-grid" x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} />
          <text className="chart-tick" x={M.l - 12} y={y(t) + 6} textAnchor="end">
            {formatValue(t, unit)}
          </text>
        </g>
      ))}
      {points.map((p, i) => {
        const cx = M.l + slot * i + slot / 2;
        const top = Math.min(y(p.value), y(0));
        const h = Math.abs(y(p.value) - y(0));
        return (
          <g key={i}>
            <rect
              className="chart-bar"
              x={cx - bw / 2}
              y={top}
              width={bw}
              height={Math.max(h, 2)}
              rx={4}
              fill={COLORS[i % COLORS.length]}
            />
            {points.length <= 8 && (
              <text className="chart-value" x={cx} y={top - 10} textAnchor="middle">
                {formatValue(p.value, unit)}
              </text>
            )}
            {shown.has(i) && (
              <text className="chart-tick" x={cx} y={H - M.b + 30} textAnchor="middle">
                {p.label}
              </text>
            )}
          </g>
        );
      })}
      <line className="chart-axis" x1={M.l} x2={W - M.r} y1={y(0)} y2={y(0)} />
    </svg>
  );
}

function donutPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return (
    `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} ` +
    `L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`
  );
}

function PieChart({ points }: { points: ChartPoint[] }) {
  const total = points.reduce((sum, p) => sum + Math.max(0, p.value), 0);
  if (total <= 0) return null;
  const cx = W / 2;
  const cy = H / 2;
  let angle = -Math.PI / 2;
  return (
    <svg className="chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {points.map((p, i) => {
        const frac = Math.max(0, p.value) / total;
        const a0 = angle;
        // A full-circle arc degenerates; stop a hair short.
        const a1 = (angle += Math.min(frac * 2 * Math.PI, 2 * Math.PI - 1e-4));
        return frac > 0 ? (
          <path key={i} d={donutPath(cx, cy, 118, 218, a0, a1)} fill={COLORS[i % COLORS.length]} className="chart-slice" />
        ) : null;
      })}
    </svg>
  );
}

export function ChartPanel({ title, kind, series, unit, xLabel, yLabel, source }: ChartPanelProps) {
  const clean = (Array.isArray(series) ? series : []).filter(
    (s) => Array.isArray(s?.points) && s.points.length > 0,
  );
  const empty = clean.length === 0;
  const first = clean[0]?.points ?? [];
  const pie = kind === "pie";
  const total = pie ? first.reduce((sum, p) => sum + Math.max(0, p.value), 0) : 0;
  // Legend: pie always (slices need naming); line only when comparing series.
  const legend: { label: string; color: string; note?: string }[] = pie
    ? first.map((p, i) => ({
        label: p.label,
        color: COLORS[i % COLORS.length],
        note: total > 0 ? `${Math.round((Math.max(0, p.value) / total) * 100)}%` : undefined,
      }))
    : kind === "line" && clean.length > 1
      ? clean.map((s, i) => ({ label: s.name ?? `Series ${i + 1}`, color: COLORS[i % COLORS.length] }))
      : [];

  return (
    <div className="chart-panel">
      <div className="chart-head">
        <div className="chart-title">{title}</div>
        {(yLabel || xLabel) && (
          <div className="chart-sub">{[yLabel, xLabel].filter(Boolean).join(" · ")}</div>
        )}
      </div>
      {empty ? (
        <div className="chart-empty">No chart data</div>
      ) : (
        <div className="chart-body">
          {kind === "line" && <LineChart series={clean} unit={unit} />}
          {kind === "bar" && <BarChart points={first} unit={unit} />}
          {pie && <PieChart points={first} />}
          {legend.length > 0 && (
            <div className="chart-legend">
              {legend.map((item, i) => (
                <div key={i} className="chart-legend-item">
                  <span className="chart-legend-chip" style={{ background: item.color }} />
                  <span className="chart-legend-label">{item.label}</span>
                  {item.note && <span className="chart-legend-note">{item.note}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {source && <div className="chart-source">{source}</div>}
    </div>
  );
}
