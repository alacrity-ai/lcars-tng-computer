# Playback Layer — Implementation Design (final)

**Ticket:** TNGC-26 · **Date:** 2026-07-23
**Supersedes:** the Computer's `docs/TNGC-26-picture-in-picture-playback.md` (consumed and deleted)
**Prereq reading:** `apps/web/src/PlaybackLayer.tsx` (after this lands), `apps/server/src/hub.ts`, `docs/sops/adding-widgets.md`, `AUDIO_FALLBACK_IMPLEMENTATION_DESIGN.md`

## 1. Problem

Displaying any panel replaced the `youtube` panel and killed playback — music
and multitasking were mutually exclusive. Ambient listening is a primary use
of the wall (TNGC-24/25 both invested in it); it must coexist with everything.

## 2. What the Computer's draft got right, and the two corrections

Right: hoist the player out of the panel tree; server owns the session; badge
in the widget stack; wall-side ducking; `mode: ambient | watch`.

Corrections (both are correctness, not taste):

1. **The ended/error guards would strand the queue.** They check
   `hub.state.view === "youtube" && props.videoId === id`; with a diagram up
   and music backgrounded, a track-end event fails the guard, the queue never
   advances, and the party dies mid-set. The guards now check the hub's
   **playback record**, which exists independently of the visible panel.
2. **Backgrounded advance can't ride a display broadcast** — it would yank
   the visible panel. A new `playback` ws message (`{action: "track", props}`
   / `{action: "stop"}`) swaps the background track without touching the
   screen. Foregrounded advance keeps using display broadcasts (panel wipe +
   history recording preserved).

Also: **"backgrounded" is derived, never stored** — playback exists AND
`state.view !== "youtube"`. A stored flag is one missed transition away from
lying; a derivation can't drift.

## 3. Architecture

```
SERVER (hub)                                  WALL
 playback record {props} | null          PlaybackLayer (persists across panels)
   set   ← display of youtube view         player element keyed videoId+audioOnly
   set   ← playback "track" msg              +startSeconds — same key = never
   null  ← media stop / queue exhausted      remounts, position survives
 backgrounded = playback && view!=="youtube"  render mode:
   → ♫ now-playing widget (kind:nowplaying)     docked  view==="youtube" (full panel
 hub.add(): resync display + widgets +                   area, title, = old panel UX)
   voice_state + playback (wall reload          pip     backgrounded && watch (corner)
   resumes the track, position resets)          hidden  backgrounded && ambient
                                              youtube registry entry renders null
```

- **Intent**: `mode?: "ambient" | "watch"` on the youtube view. Model sets
  `ambient` for background-listening requests (media skill); default =
  `ambient` when `audioOnly`, else `watch`. Backgrounding never kills:
  ambient hides, watch shrinks to PiP. Only `media stop` (or queue
  exhaustion) tears down.
- **Server flow changes** (`youtube.ts`): ended/error guard on
  `hub.playbackVideoId`; advance = display broadcast when foregrounded,
  decorated `playback track` message when backgrounded (TNGC-24 decoration
  applies in BOTH paths — a blocked track flips to audio invisibly in the
  background too). `restorePlaylist` stays a display broadcast: playing a
  playlist explicitly foregrounds it.
- **Wall flow** (`useSocket`): maintains `playback` state from display-of-
  youtube / `playback` messages / `media stop`; passes it + the current view
  to `PlaybackLayer`. The layer owns the `tng-media` listener and the
  ended/error event dispatches (moved verbatim from YouTubePanel, which is
  now a null registry entry).
- **Recall / "back to the video"**: redisplay broadcasts the same youtube
  props → same element key → the layer re-docks without reloading; position
  intact. A different `startSeconds` intentionally changes the key (seek).
- **Ducking**: `tng-duck {on}` DOM events from the speak handler (fires when
  utterance audio starts, clears in `done()`); the layer scales the player
  to 30% of its current volume and restores. Wall-side only, no round trip;
  chimes are too short to duck.
- **Full-bleed**: unchanged semantics — displaying another panel exits
  full-bleed (existing `videoFullscreen` reset) and the player backgrounds
  per its mode instead of dying.
- **Stop meaning** (decided): "stop" with music backgrounded stops the
  music — it's the only thing making sound; the visible panel stays.

## 4. Touch list

shared (PlaybackMessage, NowPlayingWidget, mode prop) · server hub (playback
record + resync + badge) · youtube.ts (guards, dual-path advance) ·
console.ts (stop clears playback; screen_state reports it) · web
(PlaybackLayer.tsx new, YouTubePanel.tsx gutted to null, useSocket, App,
lcars.css PiP/badge styles) · console-mcp (display youtube mode prop, media
stop wording) · skills: media (modes, backgrounding, stop), recall (PiP
promote).

## 5. Acceptance

- Music playing → "what's the weather" → forecast shows, music never stops,
  ♫ badge visible; "stop" ends it; the forecast stays.
- Watching a video → "show me a diagram" → video shrinks to the corner,
  audio continues; "back to the video" re-docks it, position intact.
- Backgrounded queue advances on its own — including a blocked track
  flipping to audio invisibly; skip/volume work blind.
- Computer speech audibly ducks background music, restores after.
- Wall reload mid-music resumes the track (position resets — accepted).
