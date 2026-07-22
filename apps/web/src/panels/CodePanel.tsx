import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CodePane, CodePanelProps } from "@tng/shared";
import { highlightCode } from "./codeHighlight";

/* Same readability floor as the text panel: below half size the wall is
   unreadable from across the room, so scroll instead of shrinking further. */
const MIN_FIT = 0.5;

function CodePaneView({ title, code, language, caption }: CodePane) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  const lines = useMemo(() => highlightCode(code ?? "", language), [code, language]);

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;

    const refit = () => {
      // Monospace with no wrapping: both dimensions scale linearly with font
      // size, so one measure-and-set step fits — no iteration.
      el.style.setProperty("--code-fit", "1");
      const fitW = el.clientWidth / Math.max(el.scrollWidth, 1);
      const fitH = el.clientHeight / Math.max(el.scrollHeight, 1);
      const needed = Math.min(fitW, fitH);
      const fit = needed < 1 ? Math.max(needed * 0.97, MIN_FIT) : 1;
      el.style.setProperty("--code-fit", String(fit));
      setScrollable(el.scrollHeight > el.clientHeight + 4 || el.scrollWidth > el.clientWidth + 4);
    };

    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [title, code, language, caption]);

  return (
    <div className="code-pane">
      {(title || language) && (
        <div className="code-pane-header">
          {title && <div className="code-pane-title">{title}</div>}
          {language && <div className="code-panel-lang">{language}</div>}
        </div>
      )}
      <div ref={frameRef} className={`code-panel-frame${scrollable ? " code-panel-scroll" : ""}`}>
        <pre className="code-panel-pre">
          {lines.map((tokens, i) => (
            <div className="code-line" key={i}>
              <span className="code-gutter">{i + 1}</span>
              <span className="code-line-text">
                {tokens.map((t, j) => (
                  <span key={j} className={`code-tok-${t.type}`}>
                    {t.text}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </pre>
      </div>
      {caption && <div className="code-panel-caption">{caption}</div>}
    </div>
  );
}

export function CodePanel({ title, code, language, caption, panes }: CodePanelProps) {
  const paneList = panes?.length ? panes : code?.trim() ? [{ code, language }] : [];

  if (!paneList.length) {
    return <div className="code-panel-empty">No code to display.</div>;
  }

  return (
    <div className="code-panel">
      {title && (
        <div className="code-panel-header">
          <div className="code-panel-title">{title}</div>
        </div>
      )}
      <div className="code-panel-panes">
        {paneList.map((pane, i) => (
          <CodePaneView key={i} {...pane} />
        ))}
      </div>
      {caption && <div className="code-panel-caption">{caption}</div>}
    </div>
  );
}
