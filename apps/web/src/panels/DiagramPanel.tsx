import { useMemo } from "react";
import type { DiagramPanelProps } from "@tng/shared";

/** The SVG is model-composed, not user-supplied, but strip active content
    anyway — a diagram must never be able to run code on the wall. */
function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?(<\/script>|$)/gi, "")
    .replace(/<foreignObject[\s\S]*?(<\/foreignObject>|$)/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|xlink:href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, "");
}

/**
 * Generic visual-explainer panel: renders model-composed SVG scaled to fit
 * the content area. The SVG must carry a viewBox; width/height are overridden
 * by CSS so the drawing fills whatever wall it lands on.
 */
export function DiagramPanel({ title, svg, caption }: DiagramPanelProps) {
  const clean = useMemo(() => sanitizeSvg(svg ?? ""), [svg]);
  if (!clean.trim()) {
    return <div className="diagram-panel-empty">No diagram data.</div>;
  }
  return (
    <div className="diagram-panel">
      {title && <div className="diagram-title">{title}</div>}
      <div className="diagram-canvas" dangerouslySetInnerHTML={{ __html: clean }} />
      {caption && <div className="diagram-caption">{caption}</div>}
    </div>
  );
}
