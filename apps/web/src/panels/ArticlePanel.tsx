import type { ArticlePanelProps } from "@tng/shared";
import { paginateArticle } from "@tng/shared";
import { karaokeText } from "./karaokeText";

/**
 * Reader-mode page view. The server extracts paragraphs (Readability) and the
 * panel shows one wall-sized page at a time; "computer, next page" re-opens the
 * cached article with page+1. Pagination math lives in @tng/shared so the
 * server's spoken "page N of M" matches what is drawn here.
 *
 * Karaoke mode: highlightIndex is a character position within THIS page's text
 * (paragraphs joined by single spaces). The webapp animates it locally from
 * speech timing; reading advances pages by re-displaying with page+1.
 */
export function ArticlePanel({ title, url, byline, siteName, paragraphs, page, highlightIndex }: ArticlePanelProps) {
  const pages = paginateArticle(Array.isArray(paragraphs) ? paragraphs : []);
  const meta = [siteName, byline].filter(Boolean).join(" · ");
  const current = Math.min(Math.max(page ?? 1, 1), pages.length);

  function renderParagraphWithHighlight(p: string, offset: number) {
    const inParagraph =
      highlightIndex !== undefined && highlightIndex >= offset && highlightIndex < offset + p.length;
    // Per-char spans only for the paragraph holding the caret — the rest of
    // the page renders as plain strings (small invalidation, intact kerning).
    return karaokeText(p, inParagraph ? highlightIndex - offset : undefined, "article-highlight");
  }

  let charOffset = 0;
  const currentPageParagraphs = pages[current - 1];

  return (
    <div className="article-panel">
      <div className="article-head">
        <div className="article-title">{title}</div>
        {(meta || url) && <div className="article-meta">{meta || url}</div>}
      </div>
      <div className="article-body">
        {currentPageParagraphs.map((p, i) => {
          const result = (
            <p key={i} className="article-paragraph">
              {renderParagraphWithHighlight(p, charOffset)}
            </p>
          );
          charOffset += p.length + 1; // +1 for space between paragraphs
          return result;
        })}
      </div>
      {pages.length > 1 && (
        <div className="article-pager">
          Page {current} of {pages.length}
        </div>
      )}
    </div>
  );
}
