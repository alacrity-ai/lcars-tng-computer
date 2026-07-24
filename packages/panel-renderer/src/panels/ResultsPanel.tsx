import type { ResultsPanelProps, SearchResult } from "@tng/shared";

/** Number-pill accents cycled per row, like the sidebar blocks. */
const ACCENTS = ["bg-gold", "bg-lavender", "bg-blue", "bg-peach", "bg-cream"];

/** Bare host, for the small provenance line: "en.wikipedia.org". */
function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function ResultRow({ result, index }: { result: SearchResult; index: number }) {
  return (
    <div className="result-row">
      <div className={`result-num ${ACCENTS[index % ACCENTS.length]}`}>{index + 1}</div>
      <div className="result-body">
        <div className="result-title">{result.title}</div>
        {result.snippet && <div className="result-snippet">{result.snippet}</div>}
        <div className="result-host">{host(result.url)}</div>
      </div>
    </div>
  );
}

export function ResultsPanel({ query, results }: ResultsPanelProps) {
  const list = Array.isArray(results) ? results : [];
  return (
    <div className="results-panel">
      <div className="results-head">
        <div className="results-query">{query}</div>
        <div className="results-sub">
          {list.length === 0 ? "No records found" : `${list.length} records · say a number to open one`}
        </div>
      </div>
      <div className="results-list">
        {list.map((r, i) => (
          <ResultRow key={r.url + i} result={r} index={i} />
        ))}
      </div>
    </div>
  );
}
