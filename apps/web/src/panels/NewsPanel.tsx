import type { NewsHeadline, NewsPanelProps } from "@tng/shared";

const ACCENTS = ["bg-gold", "bg-lavender", "bg-blue", "bg-peach", "bg-cream"];

function NewsItem({ headline, number, accent }: { headline: NewsHeadline; number: number; accent: string }) {
  return (
    <div className="news-item">
      <div className={`news-number ${accent}`}>{number}</div>
      <div className="news-content">
        <div className="news-title">{headline.title}</div>
        {headline.summary && <div className="news-summary">{headline.summary}</div>}
        <div className="news-meta">
          <span className="news-source">{headline.source}</span>
          {headline.time && <span className="news-time">{headline.time}</span>}
        </div>
      </div>
    </div>
  );
}

export function NewsPanel({ title = "News", headlines }: NewsPanelProps) {
  const list = Array.isArray(headlines) ? headlines : [];

  return (
    <div className="news-panel">
      <div className="news-head">
        <div className="news-title-main">{title}</div>
        <div className="news-count">{list.length} stories</div>
      </div>
      {list.length === 0 ? (
        <div className="news-empty">No headlines available</div>
      ) : (
        <div className="news-list">
          {list.map((headline, i) => (
            <NewsItem
              key={`${headline.title}-${i}`}
              headline={headline}
              number={i + 1}
              accent={ACCENTS[i % ACCENTS.length]}
            />
          ))}
        </div>
      )}
    </div>
  );
}
