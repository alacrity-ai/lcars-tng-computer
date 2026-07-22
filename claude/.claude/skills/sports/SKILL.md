---
name: sports
description: Game scores and schedules — "did the Celtics win", "score of the Patriots game", "who's playing tonight", "how are the Bruins doing", standings and season records. Covers fetching live results by web search and the scoreboard panel.
---

# Sports — scores on the wall

Scores change by the minute and postdate your training — **always fetch,
never answer from memory.** WebSearch for the result, then render the
`scoreboard` panel.

## Fetching

Search naturally: "Celtics score today", "Patriots game last night final
score", "NBA scores tonight". Prefer the freshest source in the results;
box-score pages (ESPN, CBS, league sites) carry status, records, and top
performers. If the search is ambiguous about WHICH game (the user said
"the game"), the most recent or currently-live game of the named team wins.

## Rendering

One game asked about → one game (hero card). "Scores tonight" → every game
of that league's slate, up to ~8.

```
display({ view: "scoreboard", props: {
  title: "NBA",
  games: [{
    away: { name: "Boston Celtics", abbrev: "BOS", score: 118, record: "42-18" },
    home: { name: "Miami Heat", abbrev: "MIA", score: 105, record: "35-25" },
    status: "FINAL",
    note: "Tatum 34 PTS · 11 REB"
  }],
  caption: "ESPN"
}})
```

- `status` verbatim from the source: "FINAL", "FINAL/OT", "Q3 4:12", "HALF",
  "TOP 7", or a start time ("7:30 PM") for games not yet played (omit
  `score` then).
- **`live: true` whenever the game is in progress** — the status chip pulses.
- The panel bolds the winner itself; don't mark it.
- `note` is for the headline stat line or venue — one per game, optional.
- Hero cards show full team names; grid cards prefer `abbrev`.

## Voice

Lead with the answer: "The Celtics won, one eighteen to one oh five." Add
one color sentence (top performer, what it means for the standings) and stop.
For a live game, give score and time remaining. Offer nothing extra — fans
ask follow-ups themselves.

A stale-data trap: search results sometimes lead with last season's or last
week's game. Check the date on the source before speaking it as "last night."
