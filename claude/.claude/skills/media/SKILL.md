---
name: media
description: Playing video and music — "play X", "play some jazz", "put on a movie trailer" — plus the play queue ("add X to the queue", "play X next", "skip", "what's queued") and pause/resume/stop. Video and music both mean YouTube; there is no Spotify integration.
---

# Media — video & music

**Video and music both mean YouTube.** There is no Spotify integration.

"Play some jazz" → `youtube_search`, pick a suitable video or mix, `display`
the `youtube` panel with its `videoId`, confirm briefly ("Playing jazz.").

## Always youtube_search, never WebSearch

Finding a video or song is **always** `youtube_search`. It queries YouTube's
own engine and finds small-channel uploads the web index misses.

- Titles rarely match a request word-for-word — a "prelude" cover may be titled
  "Awakening". Judge results by **channel + title together**.
- Retry with looser terms before declaring something unfindable.
- **Every result is playable.** Embed-blocked videos (`embeddable: false` —
  most major-label music) play automatically as **extracted audio** with an
  LCARS now-playing card; the server decides, you never do. Pick the best
  MATCH: for music the official blocked track beats an embeddable cover, so
  ignore the flag entirely. Only when the user explicitly wants to *watch*
  (music video, documentary, "put on X to watch") prefer `embeddable: true`.
- "Audio only" / "just the music, no video" → pass `audioOnly: true` on the
  youtube display yourself. Otherwise never set it.
- If a played video still fails on the wall, the server retries it as audio,
  then substitutes — no action needed from you.

## Picking from results

For "play some X" the user wants sound, not a decision. Pick and play.

- **Long-form wins for background listening.** A multi-hour album or full
  recording beats a three-minute clip for "play some jazz" or "play Bach
  cantatas".
- **Prefer authoritative sources for known works** — a recognized ensemble,
  label, or complete-cycle upload over an anonymous re-upload.
- View count is a weak signal; a 900-view upload of a complete cycle may be the
  right answer.
- Show the `results` panel instead of playing only when the choice is genuinely
  ambiguous.

Then `display` before `speak`, as always, and keep the confirmation to one
short line — the audio is already starting.

## Play now vs. queue — the intent call

The queue is **opt-in**. Something already playing does NOT mean a new
request goes to the queue — "play Bach" while Mozart is on means the user
changed their mind: play Bach NOW (normal `display` of the youtube panel,
which replaces Mozart).

Queue ONLY when the request itself defers: **"play Bach next"**, "after
this", "add X to the queue", "queue up X", "then some jazz". The deferral
word is the signal; without one, play immediately.

When queuing: `youtube_search`, pick the best result exactly as if playing
it, then `queue` action `add` with its videoId + title (pass channel and
durationSeconds too when the search returned them). Confirm in one line:
"Queued: Mozart's Requiem."

The server owns advancement — when the current video ends (or dies with an
error), the next queued entry starts by itself. You will not be involved
and must not wait around for it.

While the queue is non-empty the wall shows an **UP NEXT badge** (next title
plus "+N queued") automatically — don't recite the queue after adding; the
one-line spoken confirmation is enough.

- **Nothing playing when you add?** The server starts it immediately — the
  response's `nowPlaying` tells you; confirm as "Playing" not "Queued".
- **"Skip" / "next"** → `queue` action `skip`. 409 = queue empty — say so.
- **"What's in the queue?"** → action `list` (also visible in
  `screen_state`). Read titles, not videoIds.
- **"Clear the queue"** → action `clear`.
- **"Play X" while a queue exists** plays X now and leaves the queue intact
  — it resumes after X. Mention that only if the user seems surprised.
- Queue cap is 25; a full queue returns 409.
- **"Save this playlist"** (current track + everything queued, as one
  reusable item) and **"play my party mix"** (restore it later) → the
  `library` skill, action `save_playlist` / `display`.

## Transport controls

- "Pause" / "resume" / "continue" while a video is up → the `media` tool
  (`play` is resume).
- "Faster" / "slower" / "double speed" / "normal speed" → `media` action
  `speed` with `rate` (0.25–2, 1 = normal; "increase" → 1.5 unless asked
  for more). The rate resets when a new video or panel is displayed —
  re-send it after a re-display (e.g. a seek via `startSeconds`).
- "Full screen" → `media` action `fullscreen` — the video covers the whole
  wall, chrome and all. "Exit full screen" / "shrink it" → `windowed`.
  Displaying a different panel always exits full-bleed with it.
- **Volume** — "louder" / "turn it up" → `media volume_up`; "quieter" /
  "turn it down" → `volume_down` (each nudges 15). "50% volume" / "volume
  to thirty" → `volume` with `level` 0–100; "max volume!" → `level: 100`.
  "Mute" → `mute` (video keeps playing silently — that's the difference
  from `stop`); "unmute" / "sound back on" → `unmute`. Setting any level
  implicitly unmutes. Volume resets with each new video — re-send after a
  re-display if they'd set it. These control the VIDEO only, not the
  Computer's own voice.
- "Stop" / "that's enough" / "be quiet" → `media stop`. Stop also halts any
  in-progress **speech** immediately — it is the silence command even when no
  video is playing.
- Stopping **for good** and moving on → return the screen to `status`.

`media stop` during article reading leaves the article on screen — see the
`articles` skill. Don't reflexively return to `status` after a stop; wait for
the user to move on.
