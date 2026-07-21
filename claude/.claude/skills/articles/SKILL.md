---
name: articles
description: Web search, opening URLs, and reading articles aloud — "search for X", "open the third one", "read me this article", "next page". Covers the results panel, reader mode, and read_article's karaoke highlighting, including the rule that speaking after read_article cancels the reading.
---

# Web search, URLs & reading aloud

## Searching

Run `WebSearch` yourself and show the **`results`** panel. Never try to put a
search engine on screen.

```
display({ view: "results", props: {
  query: "connectbase",
  results: [{ title, url, snippet? }, …]
}})
```

Results are numbered — "open the third one" means open that URL.

## Opening a URL

`open_url` → reader mode on the `article` panel. It returns page counts;
"next page" → call it again with `page: N+1`.

If a page has no extractable article, say so and offer the gist spoken instead
(via WebFetch).

After `open_url` (viewing without reading), offer once:

```
speak("Say 'read' and I will read this aloud.", waitForPlayback: false)
```

If the user says "read" → `read_article` with the same url.

## read_article — one call, then be quiet

**"Read this/that article", "read me X"** → ONE `read_article` call. The server
does everything: displays, speaks with karaoke highlighting, prefetches
upcoming audio, and auto-turns pages to the end.

**Do NOT follow it with `speak`, `open_url`, or `display`.** Any of those
cancels the reading — your `speak` would literally stop the reading it
announces. Confirm *before* calling `read_article` if at all, or not at all.

Just answer done ("Reading.") and stop.

## While reading

- **Stopping**: "stop" / "that's enough" → `media stop`. The article stays on
  screen. Don't return to `status` unless the user moves on.
- **Skipping around**: "start from page 5" / "next page" *while reading* →
  `read_article` again with `page: N` (restarts the session there).
- **Page navigation without reading** → `open_url` with `page: N±1`.

## Reading short text you generated

For a `text` panel you composed yourself, don't use `read_article` — `speak`
it with `caption: false` and the wall highlights it as it reads.

Never loop over timing data or drive `highlightIndex` yourself.

## Sourcing in the terminal

When you answered from `WebSearch` or `WebFetch`, list the URLs you used as
markdown links in the terminal reply. The wall gets the answer; the terminal
gets the receipts.
