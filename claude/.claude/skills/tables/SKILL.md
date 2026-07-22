---
name: tables
description: Tabular answers on the wall — "compare X and Y", spec sheets, standings, rankings, nutrition facts, options with tradeoffs, any answer that is naturally rows and columns. Covers the table panel's shape, alignment, highlighting, and sizing limits.
---

# Tables — structured rows and columns on the wall

The `table` panel renders real rows and columns with an LCARS gold header
bar. Use it instead of `text` **whenever the answer is naturally tabular** —
comparisons, specs, standings, rankings — the text panel's proportional
uppercase type cannot align columns.

```
display({ view: "table", props: {
  title: "iPhone 17 vs Pixel 11",
  columns: ["", "iPhone 17", "Pixel 11"],
  rows: [
    ["Price", "$829", "$799"],
    ["Display", "6.3\" OLED", "6.4\" OLED"],
    ["Battery", "3,877 mAh", "4,970 mAh"]
  ],
  alignRight: [1, 2],
  caption: "Prices at launch, 128 GB models"
}})
```

## Props

- `columns` — header labels. First column is usually the row label; an empty
  string there is fine.
- `rows` — arrays of display strings aligned to `columns`. **Pre-format
  everything** ("$1,299", "42%", "6.3 in") — the panel renders cells verbatim.
- `alignRight` — 0-based indexes of numeric columns; numbers read better
  right-aligned.
- `highlightRows` — 0-based rows to pick out in gold (the recommendation,
  the user's team). Use sparingly: one highlight is a verdict, five is noise.
- `caption` — attribution or the one-line takeaway.

## Sizing

Cells never wrap; the wall shrinks type to fit, floor at half size, then
scrolls (useless on a wall):

- **~6 columns and ~12 rows max**, and keep cells short — "6.3\" OLED", not a
  sentence. Cut columns that don't affect the answer.
- A comparison beats a data dump: 4 well-chosen rows outrank 15 exhaustive
  ones.

## Voice

Speak the takeaway, not the cells: "The Pixel is cheaper and lasts longer;
the iPhone has the better camera." The table carries the numbers. If asked to
choose, use `highlightRows` on your pick and say why in one sentence.
