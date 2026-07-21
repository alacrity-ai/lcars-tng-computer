import { useLayoutEffect, useRef, useState } from "react";
import type { TextPanelProps } from "@tng/shared";
import { karaokeText } from "./karaokeText";

/* Shrink type no further than half size — below that the wall is unreadable
   from across the room; the scroll fallback takes over instead. */
const MIN_FIT = 0.5;

export function TextPanel({ title, body, highlightIndex }: TextPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);

  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;

    const refit = () => {
      // Measure natural height at full size. Font size scales height at worst
      // linearly (wrapping only helps), so available/needed always fits in one
      // step — no iteration, no observer feedback loop.
      el.style.setProperty("--text-fit", "1");
      const needed = el.scrollHeight;
      const available = el.clientHeight;
      // 3% undershoot + a few px of slack in the check: fractional font sizes
      // round scrollHeight up, and an exact-ratio fit can land 1-2px over,
      // which would flip the scroll class on content that visually fits.
      const fit = needed > available ? Math.max((available / needed) * 0.97, MIN_FIT) : 1;
      el.style.setProperty("--text-fit", String(fit));
      setScrollable(el.scrollHeight > el.clientHeight + 4);
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
