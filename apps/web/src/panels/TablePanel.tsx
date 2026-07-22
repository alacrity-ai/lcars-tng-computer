import { useLayoutEffect, useRef, useState } from "react";
import type { TablePanelProps } from "@tng/shared";

/* Same readability floor as the code panel: below half size the wall is
   unreadable from across the room, so scroll instead of shrinking further. */
const MIN_FIT = 0.5;

export function TablePanel({
  title,
  columns,
  rows,
  alignRight,
  highlightRows,
  caption,
}: TablePanelProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  const cols = Array.isArray(columns) ? columns : [];
  const body = Array.isArray(rows) ? rows : [];
  const rightSet = new Set(alignRight ?? []);
  const hiSet = new Set(highlightRows ?? []);

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;

    const refit = () => {
      // Cells never wrap, so both dimensions scale linearly with font size —
      // one measure-and-set step fits, no iteration.
      el.style.setProperty("--table-fit", "1");
      const fitW = el.clientWidth / Math.max(el.scrollWidth, 1);
      const fitH = el.clientHeight / Math.max(el.scrollHeight, 1);
      const needed = Math.min(fitW, fitH);
      const fit = needed < 1 ? Math.max(needed * 0.97, MIN_FIT) : 1;
      el.style.setProperty("--table-fit", String(fit));
      setScrollable(el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4);
    };

    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [title, columns, rows, caption]);

  if (!cols.length || !body.length) {
    return <div className="table-panel-empty">No table data.</div>;
  }

  return (
    <div className="table-panel">
      {title && <div className="table-panel-title">{title}</div>}
      <div ref={frameRef} className={`table-panel-frame${scrollable ? " table-panel-scroll" : ""}`}>
        <table className="table-panel-table">
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={i} className={rightSet.has(i) ? "cell-right" : undefined}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r} className={hiSet.has(r) ? "row-highlight" : undefined}>
                {cols.map((_, c) => (
                  <td key={c} className={rightSet.has(c) ? "cell-right" : undefined}>
                    {row[c] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {caption && <div className="table-panel-caption">{caption}</div>}
    </div>
  );
}
