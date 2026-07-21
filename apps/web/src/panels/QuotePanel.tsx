import type { QuotePanelProps, QuoteRange } from "@tng/shared";

/**
 * Security/crypto quote: big price + change, an LCARS sparkline of the
 * selected range, and a range-pill row that doubles as the voice menu
 * ("weekly" → the Computer re-fetches with range: weekly).
 */

const RANGES: QuoteRange[] = ["daily", "weekly", "monthly", "yearly"];

const CURRENCY_PREFIX: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

function formatPrice(v: number, currency?: string): string {
  const decimals = Math.abs(v) < 1 ? 4 : 2;
  const s = v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const prefix = currency ? CURRENCY_PREFIX[currency] : undefined;
  return prefix ? `${prefix}${s}` : currency ? `${s} ${currency}` : s;
}

function formatWhen(t: number, range: QuoteRange): string {
  const d = new Date(t);
  if (range === "daily") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (range === "weekly") return d.toLocaleDateString([], { weekday: "short", day: "numeric" });
  if (range === "monthly") return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString([], { month: "short", year: "numeric" });
}

function Sparkline({ points, up }: { points: { t: number; v: number }[]; up: boolean }) {
  const W = 1000;
  const H = 300;
  const vals = points.map((p) => p.v);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  const x = (i: number) => (i * W) / Math.max(1, points.length - 1);
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = `M0,${H} L${line.replace(/ /g, " L")} L${W},${H} Z`;
  const color = up ? "var(--lcars-gold)" : "var(--lcars-red)";

  return (
    <svg className="quote-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <path d={area} fill={color} opacity={0.14} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={3.5} strokeLinejoin="round" />
    </svg>
  );
}

export function QuotePanel(props: QuotePanelProps) {
  const { symbol, name, price, currency, change, changePercent, range, points, exchange, asOf } =
    props;
  const list = Array.isArray(points) ? points.filter((p) => typeof p?.v === "number") : [];
  const up = change >= 0;
  const sign = up ? "+" : "−";
  const vals = list.map((p) => p.v);

  return (
    <div className="quote-panel">
      <div className="quote-head">
        <div className="quote-name">{name ?? symbol}</div>
        <div className="quote-symbol">{symbol}{exchange ? ` · ${exchange}` : ""}</div>
      </div>
      <div className="quote-price-row">
        <div className="quote-price">{formatPrice(price, currency)}</div>
        <div className={up ? "quote-change up" : "quote-change down"}>
          {sign}
          {formatPrice(Math.abs(change), currency)} ({sign}
          {Math.abs(changePercent).toFixed(2)}%)
        </div>
      </div>
      {list.length >= 2 && (
        <div className="quote-chart">
          <div className="quote-hilo">
            <span>{formatPrice(Math.max(...vals), currency)}</span>
            <span>{formatPrice(Math.min(...vals), currency)}</span>
          </div>
          <div className="quote-spark-wrap">
            <Sparkline points={list} up={up} />
            <div className="quote-timeline">
              <span>{formatWhen(list[0].t, range)}</span>
              <span>{formatWhen(list[list.length - 1].t, range)}</span>
            </div>
          </div>
        </div>
      )}
      <div className="quote-foot">
        <div className="quote-ranges">
          {RANGES.map((r) => (
            <span key={r} className={r === range ? "quote-range active" : "quote-range"}>
              {r}
            </span>
          ))}
        </div>
        {asOf && (
          <div className="quote-asof">
            As of {new Date(asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </div>
        )}
      </div>
    </div>
  );
}
