import type { ReactNode } from "react";

/**
 * Karaoke text rendering. While a caret is active the text renders as one
 * span per character, so each caret move mutates only two spans' classNames —
 * two tiny paint invalidations. The previous approach (re-rendering
 * before/caret/after text nodes) replaced the block's text nodes every 50ms,
 * forcing the compositor to re-raster the whole text block each tick; on the
 * kiosk's WSLg GPU stack the stale raster could linger on screen alongside
 * the fresh one — text visibly "drawn twice", sometimes at the pre-auto-fit
 * size. Inactive text renders as a plain string (fast path, perfect kerning).
 */
export function karaokeText(
  text: string,
  highlightIndex: number | undefined,
  caretClass: string,
): ReactNode {
  if (highlightIndex === undefined || highlightIndex < 0 || highlightIndex >= text.length) {
    return text;
  }
  // split("") keeps UTF-16 indexing consistent with the server's char math.
  return text.split("").map((ch, i) => (
    <span key={i} className={i === highlightIndex ? caretClass : undefined}>
      {ch}
    </span>
  ));
}
