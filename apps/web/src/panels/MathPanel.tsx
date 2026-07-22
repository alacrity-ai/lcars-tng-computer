import { useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { MathLine, MathPanelProps } from "@tng/shared";

function render(latex: string): string {
  return katex.renderToString(latex ?? "", {
    displayMode: true,
    throwOnError: false,
    errorColor: "#cc6666",
  });
}

function Line({ line }: { line: MathLine }) {
  const html = useMemo(() => render(line.latex), [line.latex]);
  return (
    <div className="math-line">
      {/* KaTeX output is generated locally from our own LaTeX, not user HTML. */}
      <div className="math-tex" dangerouslySetInnerHTML={{ __html: html }} />
      {line.note && <div className="math-note">{line.note}</div>}
    </div>
  );
}

export function MathPanel({ title, lines, caption }: MathPanelProps) {
  const list = Array.isArray(lines) ? lines : [];
  if (!list.length) {
    return <div className="math-panel-empty">No mathematics to display.</div>;
  }

  return (
    <div className="math-panel">
      {title && <div className="math-title">{title}</div>}
      <div className="math-lines">
        {list.map((line, i) => (
          <Line key={i} line={line} />
        ))}
      </div>
      {caption && <div className="math-caption">{caption}</div>}
    </div>
  );
}
