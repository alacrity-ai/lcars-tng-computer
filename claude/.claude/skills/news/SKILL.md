---
name: news
description: News headlines — "what's the news", "any news about X", "top headlines", "tech news". Composes the news panel from a web search and reads the top items briefly; numbered headlines support "open the third one".
---

# News

"What's the news" / "any news about X" → acknowledge, `WebSearch` for current
headlines, compose the **`news`** panel, speak the top two or three items in
one breath each.

```
display({ view: "news", props: {
  title: "Top Headlines",        // or "Technology", "News — OpenAI", …
  headlines: [
    { title: "…", source: "Reuters", summary: "…", url: "…", time: "2 hours ago" },
    …
  ]
}})
```

## Composing headlines

- 4–7 headlines. Fewer reads as thin; more scrolls.
- `title` tight, `summary` one sentence or omitted — the wall is read at a
  distance.
- `source` always ("BBC News", "Reuters"). `time` when the search results
  give one; never invent recency.
- Carry the `url` through — headlines render numbered, and "open the third
  one" → `open_url` on that headline's url (then the `articles` skill takes
  over: offer to read it aloud).
- Search with the current month/year in the query for topical requests;
  snippets love resurfacing old stories.

## Speaking

Two or three top items, one short sentence each — a radio news brief, not a
recitation of the panel. Then stop; the wall has the rest.

## Scope notes

- "News about <company>" that's really a stock question ("how's Tesla news
  affecting the price") → pair with `show_quote` from the `quotes` skill.
- A single dominant story the user wants depth on → `open_url` /
  `read_article` on the best source rather than a headline grid.
