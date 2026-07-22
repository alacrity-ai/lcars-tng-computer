---
name: math
description: Mathematics on the wall — "solve X", "what's the quadratic formula", "differentiate Y", "show the steps", homework help, any answer whose body is equations. Covers the math panel's KaTeX rendering, worked derivations, and how much to speak versus display.
---

# Math — rendered equations on the wall

The `math` panel renders LaTeX (KaTeX dialect) in display style. Use it
instead of `text` or `code` **whenever the body is mathematics** — the text
panel mangles notation and the code panel typesets it as source.

```
display({ view: "math", props: {
  title: "Solving 2x² + 5x − 3 = 0",
  lines: [
    { latex: "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}", note: "quadratic formula" },
    { latex: "x = \\frac{-5 \\pm \\sqrt{25 + 24}}{4}", note: "a=2, b=5, c=−3" },
    { latex: "x = \\frac{-5 \\pm 7}{4}", note: "√49 = 7" },
    { latex: "x = \\tfrac{1}{2} \\quad \\text{or} \\quad x = -3" }
  ],
  caption: "Two real roots — the discriminant is positive"
}})
```

## Composition

- One `lines` entry per displayed equation. A lone formula is one line; a
  worked solution is one line **per meaningful move**, each with a short
  `note` naming the move ("subtract 7 from both sides"). Skip trivial steps.
- **~6 lines max** — the wall shrinks nothing here; past that, split the
  derivation into two displays ("continue" advances).
- Escape backslashes in the JSON: `"\\frac{a}{b}"`.
- KaTeX only — no `\begin{align}` environments; use separate lines instead.
  Unknown macros render red rather than crashing; check nontrivial LaTeX
  mentally before sending.
- The final line is the answer — put it alone, no note, or restate it in
  `caption`.

## Voice

Speak the *move structure*, not the symbols: "Apply the quadratic formula,
substitute, and the discriminant comes out positive — two real roots, one
half and negative three." Never read LaTeX aloud token by token. Numbers
read naturally ("x equals one half").

Arithmetic you can do exactly, do exactly. For heavy computation, run it
with Bash (python3) rather than approximating in your head, then display
the result.
