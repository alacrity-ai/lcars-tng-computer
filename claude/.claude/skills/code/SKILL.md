---
name: code
description: Showing source code on the wall — "show me the code", "write a function to X", "how do I do X in Python", "what would that look like in Rust", side-by-side language comparisons, any answer whose body is code. Covers the code panel's syntax highlighting, side-by-side panes, sizing limits, and how much to speak versus display.
---

# Code — syntax-highlighted source on the wall

The `code` panel renders monospace source with LCARS syntax colors and a
line-number gutter. Use it instead of the `text` panel **whenever the body
is code** — the text panel uppercases and proportionally spaces everything,
which mangles source.

```
display({ view: "code", props: {
  title: "Fibonacci — Python",
  language: "python",
  code: "def fib(n):\n    a, b = 1, 1\n    ...",
  caption: "Iterative — O(n) time, O(1) space"
}})
```

## Props

- `code` (required) — the source, verbatim. Real newlines and spaces;
  indentation is preserved exactly.
- `language` — highlighting hint: `python`, `javascript`, `typescript`,
  `bash`, `sql`, `c`, `java`, `go`, `rust`… Anything unknown falls back to
  a generic C-like highlighter, so always pass what you know. Shown as a
  badge on the panel.
- `title` — headline: "Fibonacci — Python", "Quicksort".
- `caption` — one line under the code: complexity note, the key insight,
  the output.
- `panes` — 2–3 sources rendered side-by-side, each `{title?, code,
  language?, caption?}`; pass either `code` or `panes`. Use for the same
  algorithm in different languages or before/after comparisons:

```
display({ view: "code", props: {
  title: "Fibonacci — Python vs TypeScript",
  panes: [
    { title: "Python", language: "python", code: "def fib(n): ..." },
    { title: "TypeScript", language: "typescript", code: "function* fib(n: number) ..." }
  ]
}})
```

## Sizing

The wall shrinks type to fit both width and height, floor at half size,
then scrolls — and scrolling is useless on a wall display:

- **~30 lines and ~80 columns max.** Past that, cut the code, not the font:
  drop imports, error handling, and boilerplate that isn't the point.
- Side-by-side panes split the width: keep each pane under ~45 columns,
  or the type shrinks past readability.
- One idea per screen. Two contrasting implementations fit only if both are
  short; otherwise show them one at a time.
- Comments in the code should earn their line — prefer a `caption` over
  comment noise.

## Voice

Speak a 1–2 sentence walkthrough of the *idea* (the algorithm, the trick),
not the syntax. Never read code aloud token by token; the panel carries the
detail. If the user asks to run it, run it with Bash and report the output.
