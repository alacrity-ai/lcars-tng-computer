---
name: recall
description: Bringing back ANYTHING previously shown, even moments ago — "show me that diagram again", "play that video again", "back to the recipe", "go back to the article", "what was on screen earlier". Replays the recorded panel verbatim from server history; never re-send remembered props instead.
---

# Recall — the replay history

The server records every content panel it broadcasts (last 50; status/blank
excluded — a re-shown screen updates its entry rather than duplicating).
`display_history` lists them newest first as `{id, ts, view, summary}`;
`redisplay {id}` puts one back on the wall verbatim. Nothing is regenerated —
a diagram's SVG, an article's text, a video's id all replay in one round trip.

## Hit or miss — read the intent

- **"again / that one / earlier / back to"** → `display_history`, find the
  entry (match view + summary), `redisplay` it, confirm in one short
  sentence: "On screen."
- Still having the props in context is NOT an exemption: never re-send a
  remembered `display` call to go back. `redisplay` is one round trip,
  guaranteed verbatim, and keeps server history the single source of truth.
  This applies even seconds after the original display (e.g. flipping
  between a recipe and its ingredient table).
- **"new / another / different X"** → the user is declining the old one.
  Generate fresh; don't consult history.
- **No matching entry** → a miss is silent, never an error: produce the
  content normally, as if history didn't exist.

## Notes

- Two plausible matches ("the Ohm's law diagram" when there are two) → pick
  the newest when the phrasing implies recency, otherwise ask one short
  question.
- A replayed `youtube` panel restarts the video from the beginning.
- History outlives context compaction — trust it over your memory of what
  props you composed earlier in a long session.
- Redisplaying re-records the entry as newest; that's correct — it IS the
  current screen.
- History is in-memory: a server restart clears it. If an expected entry is
  missing, fall through to regenerating without comment.
