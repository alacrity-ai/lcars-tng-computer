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

## Prebuilt assets — the diagram cache

Some diagrams are big, deterministic, and asked for repeatedly. Their
finished SVG lives under `assets/`. **Before building any diagram, check
the library below** — if it's there, display it by reference and don't
rebuild it by hand:

```
display({ view: "diagram", props: { svgAsset: "periodic-table", title: "…", caption: "…" } })
```

Pass **`svgAsset: "<slug>"` instead of `svg`** — the console's hands read
`assets/<slug>.svg` on the server side and slot it in, so the ~30k
characters never pass through you. Do **not** Read the `.svg` file and
inline it into the `svg` prop; that pumps every byte through your context
(slow, exactly what the cache exists to avoid). `svgAsset` and `svg` are
mutually exclusive — a hand-composed diagram still passes `svg`.

**When to save.** Two triggers, same procedure:
- the user says so — "save this diagram", "keep that", "remember this one";
- you just built something slow and deterministic that will plainly be
  asked for again.

Only cache **timeless** content (anatomy, orbits, the periodic table).
Never cache anything that goes stale — prices, standings, weather,
anything with a date on it. When in doubt, don't.

**How to save:**
1. Write the SVG to `assets/<kebab-slug>.svg` (the exact SVG you displayed).
2. If a script generated it, save that too as `assets/<kebab-slug>.gen.*`
   — future edits are edit-and-re-run, not redraw. Hand-built SVGs have no
   generator; that's fine.
3. Add a bullet to the library below: the **slug** (its `svgAsset` value),
   what it shows, the display title to use, and the generator if one exists.
4. Confirm to the user in one spoken sentence ("Saved — I can show that
   instantly now.").

The slug is just the filename without `.svg`: `assets/periodic-table.svg`
→ `svgAsset: "periodic-table"`. Slugs are kebab-case; the resolver rejects
anything else.

### Library

- **`periodic-table`** — all 118 elements, colored by family, legend and
  f-block rows included. Title it "The Periodic Table of the Elements".
  The generator that produced it is `assets/periodic-table.gen.py` (data +
  layout, ~50px cells on a 950×498 canvas) — edit and re-run that if the
  table itself needs changing, then overwrite `assets/periodic-table.svg`.
