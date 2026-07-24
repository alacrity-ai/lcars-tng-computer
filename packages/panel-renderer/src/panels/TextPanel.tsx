import { useLayoutEffect, useRef, useState } from "react";
import type { TextPanelProps } from "@tng/shared";
import { karaokeText } from "./karaokeText";

/* Shrink type no further than half size — below that the wall is unreadable
   from across the room; the scroll fallback takes over instead. */
const MIN_FIT = 0.5;

export function TextPanel({ title, body, highlightIndex }: TextPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  const lastFit = useRef(1);

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    lastFit.current = 1;

    const refit = () => {
      // Measure natural height at full size. Font size scales height at worst
      // linearly (wrapping only helps), so available/needed always fits in one
      // step — no iteration.
      el.style.setProperty("--text-fit", "1");
      const needed = el.scrollHeight;
      const available = el.clientHeight;
      // 3% undershoot + a few px of slack in the check: fractional font sizes
      // round scrollHeight up, and an exact-ratio fit can land 1-2px over,
      // which would flip the scroll class on content that visually fits.
      let fit = needed > available ? Math.max((available / needed) * 0.97, MIN_FIT) : 1;
      // Convergence guard: successive measurements straddle our own side
      // effects (scroll class, fractional rounding). Echoing a marginally
      // different fit re-triggers the observer forever — the panel then
      // strobes between two offset layouts every frame. Sub-visual changes
      // keep the previous answer, so the observer goes quiet.
      if (Math.abs(fit - lastFit.current) < 0.02) fit = lastFit.current;
      lastFit.current = fit;
      el.style.setProperty("--text-fit", String(fit));
      // Hysteresis for the same reason: once scrolling, stay scrolling until
      // the content is clearly short — the scroll state's own layout shift
      // must never argue the decision back the other way.
      const over = el.scrollHeight - el.clientHeight;
      setScrollable((prev) => (prev ? over > -16 : over > 4));
    };

    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [title, body]);

  return (
    <div ref={panelRef} className={`text-panel${scrollable ? " text-panel-scroll" : ""}`}>
      {title && <div className="text-panel-title">{title}</div>}
      <div className="text-panel-body">{karaokeText(body, highlightIndex, "text-highlight")}</div>
    </div>
  );
}
