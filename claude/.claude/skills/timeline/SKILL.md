---
name: timeline
description: Chronologies on the wall — "timeline of X", "history of Y", "how did Z unfold", the life of a person, the arc of a war, project or era sequences. Covers the timeline panel's era band, event budget, and when a chart or diagram fits better.
---

# Timeline — horizontal era band on the wall

The `timeline` panel lays events along a horizontal gold-dotted axis, cards
alternating above and below. Use it when **sequence is the answer** —
history, biographies, how a crisis unfolded.

```
display({ view: "timeline", props: {
  title: "The Space Race",
  events: [
    { when: "1957", title: "Sputnik 1", detail: "First artificial satellite stuns the West." },
    { when: "1961", title: "Gagarin orbits Earth", detail: "First human in space." },
    { when: "1962", title: "\"We choose to go to the Moon\"" },
    { when: "1968", title: "Apollo 8 circles the Moon" },
    { when: "1969", title: "Apollo 11 lands", detail: "Armstrong and Aldrin walk on the Moon." }
  ],
  caption: "Twelve years from first satellite to first footprint"
}})
```

## Composition

- **Events render evenly spaced in array order** — readability over
  proportional spacing. Chronological order is on you; the panel doesn't sort.
- **4–8 events.** The skill of a good timeline is choosing the turning
  points, not listing everything. Fewer, well-chosen beats crowded.
- `when` is a display string — "1969", "Mar 1865", "Day 3" all work. Keep one
  granularity per timeline.
- `title` ≤ ~6 words; `detail` one short sentence, and omit it freely — a
  bare title card is fine.

## When something else fits better

- Numeric values over time (population, price) → `chart`, kind line.
- Branching or causal structure (this led to these two) → `diagram`.
- A single event in depth → `text` or `show_profile`.

## Voice

Speak the arc, not the list: name the span, the inflection point, and how it
ended. Two or three sentences; the band carries the dates.
