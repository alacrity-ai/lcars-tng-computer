---
name: composite
description: Building dashboards and status boards from LCARS primitives — "make me a dashboard of X", "show everything about Y on one screen", multi-part status displays, or any request no dedicated panel fits. Also the panel language plugins use.
---

# Composite — the dashboard builder

`display view:"composite"` renders a tree of LCARS primitives. Reach for it
when the user wants SEVERAL kinds of information on one screen ("a dashboard
of my day", "one screen with the score, the weather, and my timers") or when
no dedicated panel matches. When a dedicated panel fits (chart, table,
weather…), always prefer it — composite is the fallback and the combiner.

## Shape

```json
{"title": "MORNING BOARD", "columns": 2, "blocks": [
  {"type": "group", "title": "WEATHER", "accent": "blue", "items": [
    {"type": "readout", "label": "Now", "value": 72, "unit": "°F"},
    {"type": "gauge", "label": "Rain chance", "value": 0.2, "text": "20%"}
  ]},
  {"type": "group", "title": "SYSTEMS", "accent": "gold", "items": [
    {"type": "status", "label": "Front door", "state": "on", "detail": "locked"},
    {"type": "sparkline", "label": "Net latency", "points": [12, 14, 11, 30, 12], "unit": "ms"}
  ]},
  {"type": "text", "body": "One-line summary if words help.", "role": "caption"}
]}
```

Blocks: `group` (titled section, nests once or twice — max depth 3),
`readout` (label + big value), `status` (on|off|warn|alert|idle chip),
`gauge` (0..1 bar, optional overlay text), `text` (body|caption),
`list` ({label, detail?} rows), `keyvalue` (pairs table),
`sparkline` (numeric trend, ≤200 points), `swatch` (a rendered color chip —
`{label, color: "#rrggbb", detail?}` — for showing an actual color, not
naming one), `divider`.
Accents: gold, peach, lav, blue, red.

## Judgment

- **Groups are rooms/topics; 2 columns for 3+ groups**, 1 column for a
  focused board. Never bury one number in a lone group — use a readout row.
- Hard caps: 64 blocks, depth 3, 16 KB. The wall scrolls past one screen —
  cut content instead; a dashboard nobody can read across the room failed.
- Live updates: re-display the same view with changed props — the wall
  refreshes in place (no wipe). Rate limit is 2/s; batch changes.
- `state: "alert"` blinks — reserve it for things that genuinely need eyes.
- Numbers: pre-format (`"72"`, unit separately). `sparkline` for trends,
  `gauge` for levels/percentages, `readout` for a single figure.
- Plugins broadcast their own composite panels (e.g. lighting) — those
  refresh themselves; regenerate one only if asked to change what it shows.
