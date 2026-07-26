import { useState } from "react";
import type {
  CompositeAccent,
  CompositeBlock,
  CompositeIcon,
  CompositePanelProps,
} from "@tng/shared";

/* The composite panel (TNGC-33): renders the declarative panel language —
   plugin- and model-authored dashboards built from LCARS primitives. All
   content is data: strings land as text nodes, vectors come by same-origin
   reference through <img> (no scripts execute). Unknown block types render
   a placard, never a crash — the schema evolves additively. */

const ACCENT_VAR: Record<CompositeAccent, string> = {
  gold: "var(--gold)",
  peach: "var(--peach)",
  lav: "var(--lav)",
  blue: "var(--blue)",
  red: "var(--red)",
};

const STATE_ACCENT: Record<string, string> = {
  on: "var(--gold)",
  off: "#3a3a3a",
  warn: "var(--peach)",
  alert: "var(--red)",
  idle: "var(--blue)",
};

function accent(a: CompositeAccent | undefined, fallback = "var(--gold)"): string {
  return a ? ACCENT_VAR[a] ?? fallback : fallback;
}

/* Glyphs are drawn from THIS table, never from props — a block names one, the
   renderer owns the geometry. Unknown names fall through to text-only. */
const ICON_PATH: Record<CompositeIcon, string> = {
  bulb: "M12 3a6 6 0 0 0-3.4 10.9V16h6.8v-2.1A6 6 0 0 0 12 3zM9.4 18.4h5.2M10.4 20.9h3.2",
  thermometer: "M12 3a2 2 0 0 0-2 2v8.3a4 4 0 1 0 4 0V5a2 2 0 0 0-2-2z",
  droplet: "M12 3s5.5 6 5.5 9.5a5.5 5.5 0 1 1-11 0C6.5 9 12 3 12 3z",
  bolt: "M13 2 4.5 13.5H11L10 22l8.5-11.5H12L13 2z",
};

function Glyph({ d, color }: { d: string; color: string }) {
  return (
    <svg className="cp-status-icon" viewBox="0 0 24 24" aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Sparkline({ points, color }: { points: number[]; color: string }) {
  if (points.length < 2) return null;
  const w = 240;
  const h = 48;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p - min) / span) * (h - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="cp-sparkline-svg" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <path d={path} fill="none" stroke={color} strokeWidth="2.5" />
    </svg>
  );
}

/** A same-origin asset can be unreachable from where this renderer runs (a
    tricorder behind an old bridge that doesn't inline them yet — TNGC-37);
    degrade to a placard, never a broken-image glyph. */
function SvgBlock({ assetUrl, caption }: { assetUrl: string; caption?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <div className="cp-unknown">Graphic unavailable{caption ? ` — ${caption}` : ""}</div>;
  }
  return (
    <figure className="cp-svg">
      <img src={assetUrl} alt={caption ?? ""} onError={() => setFailed(true)} />
      {caption && <figcaption className="cp-caption">{caption}</figcaption>}
    </figure>
  );
}

function Block({ block }: { block: CompositeBlock }) {
  switch (block.type) {
    case "group":
      return (
        <section className="cp-group">
          <header className="cp-group-head" style={{ background: accent(block.accent) }}>
            <span className="cp-group-cap" />
            {block.title}
          </header>
          <div className="cp-group-body">
            {block.items.map((b, i) => (
              <Block key={i} block={b} />
            ))}
          </div>
        </section>
      );
    case "readout":
      return (
        <div className="cp-readout">
          <span className="cp-label">{block.label}</span>
          <span className="cp-readout-value" style={{ color: accent(block.accent, "#fff") }}>
            {String(block.value)}
            {block.unit && <span className="cp-readout-unit"> {block.unit}</span>}
          </span>
        </div>
      );
    case "status": {
      const color = STATE_ACCENT[block.state] ?? "var(--blue)";
      const lit = block.state !== "off";
      // Validator guarantees #rrggbb; re-check anyway before it hits a style.
      const chip = block.swatch && /^#[0-9a-fA-F]{6}$/.test(block.swatch) ? block.swatch : null;
      const glyph = block.icon ? ICON_PATH[block.icon] : undefined;
      const metric = block.value || glyph;
      return (
        <div className="cp-status">
          <span
            className={`cp-status-chip${block.state === "alert" ? " cp-status-blink" : ""}`}
            style={{ background: color, color: lit ? "var(--ink)" : "#888" }}
          >
            {block.state.toUpperCase()}
          </span>
          <span className="cp-status-label">{block.label}</span>
          {/* Everything past the label is right-aligned trim: metric, color,
              then the detail line — one fixture, one row. */}
          {metric && (
            <span className="cp-status-metric">
              {glyph && <Glyph d={glyph} color={lit ? color : "#666"} />}
              {block.value && <span className="cp-status-value">{block.value}</span>}
            </span>
          )}
          {chip && <span className="cp-status-swatch" style={{ background: chip }} />}
          {block.detail && <span className="cp-status-detail">{block.detail}</span>}
        </div>
      );
    }
    case "gauge": {
      const pct = Math.max(0, Math.min(1, block.value)) * 100;
      return (
        <div className="cp-gauge">
          <span className="cp-label">{block.label}</span>
          <span className="cp-gauge-track">
            <span className="cp-gauge-fill" style={{ width: `${pct}%`, background: accent(block.accent) }} />
            {block.text && <span className="cp-gauge-text">{block.text}</span>}
          </span>
        </div>
      );
    }
    case "text":
      return <p className={block.role === "caption" ? "cp-caption" : "cp-text"}>{block.body}</p>;
    case "list":
      return (
        <ul className="cp-list">
          {block.items.map((it, i) => (
            <li key={i}>
              <span className="cp-list-bar" style={{ background: accent(it.accent, "var(--blue)") }} />
              <span className="cp-list-label">{it.label}</span>
              {it.detail && <span className="cp-list-detail">{it.detail}</span>}
            </li>
          ))}
        </ul>
      );
    case "keyvalue":
      return (
        <table className="cp-kv">
          <tbody>
            {block.pairs.map((p, i) => (
              <tr key={i}>
                <td className="cp-kv-k">{p.k}</td>
                <td className="cp-kv-v">{String(p.v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case "sparkline":
      return (
        <div className="cp-sparkline">
          <span className="cp-label">
            {block.label}
            {block.unit && <span className="cp-readout-unit"> ({block.unit})</span>}
          </span>
          <Sparkline points={block.points} color={accent(block.accent, "var(--blue)")} />
        </div>
      );
    case "swatch": {
      // Validator guarantees #rrggbb; re-check anyway before it hits a style.
      const chip = /^#[0-9a-fA-F]{6}$/.test(block.color) ? block.color : "#000000";
      return (
        <div className="cp-swatch">
          <span className="cp-label">{block.label}</span>
          <span className="cp-swatch-chip" style={{ background: chip }} />
          {block.detail && <span className="cp-swatch-detail">{block.detail}</span>}
        </div>
      );
    }
    case "svg":
      return <SvgBlock assetUrl={block.assetUrl} caption={block.caption} />;
    case "divider":
      return <hr className="cp-divider" />;
    default:
      return (
        <div className="cp-unknown">UNSUPPORTED BLOCK “{(block as { type?: string }).type ?? "?"}”</div>
      );
  }
}

export function CompositePanel({ title, accent: panelAccent, columns, blocks }: CompositePanelProps) {
  const list = Array.isArray(blocks) ? blocks : [];
  const cols = Math.max(1, Math.min(3, Math.trunc(columns ?? 1)));
  if (!list.length) return <div className="cp-unknown">Empty composite panel.</div>;
  return (
    <div className="cp-panel">
      {title && (
        <div className="cp-title" style={{ borderColor: accent(panelAccent) }}>
          {title}
        </div>
      )}
      <div className="cp-columns" style={{ columnCount: cols }}>
        {list.map((b, i) => (
          <div className="cp-block" key={i}>
            <Block block={b} />
          </div>
        ))}
      </div>
    </div>
  );
}
