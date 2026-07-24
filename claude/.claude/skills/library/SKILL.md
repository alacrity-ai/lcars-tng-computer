---
name: library
description: Each household member's personal Tricorder library — "save to my tricorder", "save this for me", "what's in my library", "show my saved diagrams", "show my saved bread recipe", "send this to Ariel", "delete that from my library". Cloud persistence, distinct from recall (which is this session's wall history).
---

# Library — saved wall primitives

Whatever is on the wall — the diagram, the recipe, the table, the article — can
be **saved to a person's tricorder**: it lands in their cloud library, shows up
in their phone app, and can be put back on the wall any time, instantly.

Everything goes through the `library` tool. **The iron rule: payloads never
pass through you.** Save captures the wall server-side; display resolves by id
server-side. Never Read a saved payload, never rebuild a saved item from
memory — that burns tens of thousands of tokens for nothing.

## Saving — "save to my tricorder" / "save this"

`library save {owner}` captures the **current** wall panel.

- **owner = the channel event's user**, always — "my" means the speaker
  (ariel's "save this" goes to ariel's library), never the session owner.
- Typed terminal input has no channel user → it's leif at the console; default
  to `leif`.
- "Save **that**" when the wall has already moved on: `display_history` →
  `redisplay` the panel first, then save. The save target is always what the
  wall shows *now*.
- Not savable (status board, alerts): the tool says so — tell the user there's
  nothing on screen to save.
- Confirm in one short line: "Saved to your tricorder." The title is already
  sensible (the wall's summary line) — don't recite it.

## Finding & showing — "show my saved warp core diagram"

1. `library search {owner, q?, family?}` — metadata only (id, title, family,
   view, age). Match loosely: "my bread recipe" → q: "bread".
2. One clear match → `library display {id}` and confirm ("On screen."). It's a
   frozen copy shown instantly — nothing is regenerated.
3. Several plausible matches → speak the titles and let them pick. None →
   say so; offer to make it fresh.

"What's in my library" / "my saved diagrams" → search (family: visual for
diagrams) and **speak titles, never ids**. Families: prose (text/articles),
data (charts/tables/quotes/weather/scores/timelines), visual
(diagrams/images/maps), procedure (steps/quizzes), notation (code/math),
media (youtube bookmarks).

Saved `data`-family items are snapshots — "your saved AAPL quote is from
January" beats presenting stale numbers as current. Offer a fresh lookup.

## Playlists — "save this playlist" / "play my party mix"

The whole music session — the playing track PLUS every queued track, in
order — saves as **one playlist item**:

- "Save this playlist (to my tricorder)" → `library save_playlist {owner}`.
  A spoken name ("…as party mix") → pass `name`. Confirm with the count:
  "Saved: nineteen tracks."
- "Play my party mix" / "put on my saved playlist" → search (it's in the
  media family), then `library display {id}` — this **replaces** the current
  play queue and starts track one. Confirm briefly with the count.
- Nothing playing or queued → the tool 409s; say there's no playlist to save.
- A single playing track with an empty queue saves fine, but plain `save`
  (the youtube bookmark) is usually what they mean then.

## Sending — "send this to Ariel"

A copy lands in the recipient's library, marked as from the sender.

- Item already saved → `library send {id, to}`.
- Spoken about what's ON the wall right now → save to the **speaker's**
  library first, then send that id. One breath: "Saved and sent to Ariel."
- Recipients see it in their phone app; there is no wall notification.

## Deleting — "delete that from my library"

`library remove {id}` — search first so you delete the right thing, and if the
title match isn't obvious, confirm aloud before removing. Deleting never
touches copies already sent to others.

## Not this skill

- "Show that diagram **again**" (same session, wall history) → `recall`.
- "Save this diagram" meaning a **reusable skill asset** the Computer itself
  regenerates (periodic table class of thing) → `diagrams` skill. Rule of
  thumb: *people* own library items; the *Computer* owns skill assets. When
  someone says "save to my tricorder", it's always this skill.

## Multi-wall note (TNGC-35)

`library display` paints the viewscreen the command came from — automatic,
like every display path. Only when the person names a DIFFERENT room ("show
my bread recipe on the kitchen wall") pass `wall: "kitchen"` on the display
action. The phone-side "Display on wall" button honors the user's wall
selection on its own.
