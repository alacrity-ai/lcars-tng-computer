---
name: diagrams
description: Visual explanations of concepts — "show me visually", "draw how X works", "diagram this" — recursion trees, flow diagrams, architectures, geometry, algorithm walkthroughs. Anything explanatory the chart panel's line/bar/pie shapes can't express. For numeric data over time or categories, use the charts skill instead.
---

# Diagrams — composed SVG on the wall

The `diagram` panel renders SVG **you compose yourself**. There is no
diagram engine; your markup is the diagram.

```
display({ view: "diagram", props: {
  title: "Fibonacci Recursion",
  svg: "<svg viewBox=\"0 0 960 540\" xmlns=\"http://www.w3.org/2000/svg\">…</svg>",
  caption: "fib(4) call tree — shaded calls are recomputed duplicates"
}})
```

## Composition rules

- **viewBox is mandatory**, width/height attributes are not (CSS scales the
  drawing to the content area, ~16:9). Design on a 960×540 canvas.
- **LCARS palette on transparent** (the wall is near-black): gold `#ffcc66`,
  peach `#ffcc99`, blue `#9999ff`, lavender `#cc99cc`, red `#cc6666`,
  cream `#f5f6fa`. No white backgrounds, no default-black strokes/fills.
- Text: `fill` one of the palette colors, `font-size` 20+ (wall is read at a
  distance), no more than ~40 words total. Label nodes tersely.
- Scripts, event handlers, and foreignObject are stripped — pure shapes,
  paths, and text only.
- Keep node counts honest: a recursion tree to depth 4, a flow of 6–8 boxes.
  Past that the wall becomes unreadable; simplify rather than shrink.

## When to pick diagram vs chart vs text

- Numeric series over time/categories → `chart` (see charts skill).
- Structure, flow, hierarchy, geometry, before/after — anything where
  *arrangement* carries the meaning → `diagram`.
- Prose explanation → `text` panel; add a diagram only when the spatial
  form genuinely explains more than sentences.

Speak a 1–2 sentence walkthrough after displaying; let the diagram carry
the detail.
