---
name: nightsky
description: The live sky overhead — "what's in the sky tonight", "show me the stars", "where is Mars/Jupiter/Orion right now", "show me the moon phase", "what will the sky look like at midnight / in March", star-gazing and time-lapse requests. A real computed planetarium panel, steered in place by sky_control; not for pictures of space (that's subjects) or sky maps of other worlds.
---

# Night sky — a live planetarium on the wall

The `night-sky` panel is not a picture: the wall computes the sky itself from
a bundled star catalog and real ephemerides, then keeps it running in real
time. Display it once, then steer it with `sky_control` — never re-display to
move, zoom, or change time.

```
display({ view: "night-sky", props: {
  lat: 42.36, lng: -71.06,
  title: "Tonight's Sky"
}})
```

Defaults: the whole-sky dome (fov 180, zenith-centered) at the present
moment, with constellations, labels, and planets on. That's the right
opening view for "what's in the sky tonight" — orient, then zoom where the
conversation goes.

- **Location**: use the household's coordinates if known; otherwise ask once
  ("For which location?") and remember the answer. `time` (ISO) shows a
  moment other than now.
- The panel understands daylight: the sky tints toward slate, stars wash
  out, and a DAYLIGHT chip appears. For "tonight" during the day, display
  with `time` set to ~22:00 local — don't show a noon sky.

## Steering — sky_control

Space verbs (like map_control):

- "zoom in / out" → `zoom_in` / `zoom_out` (amount = steps, "way in" ≈ 3).
- "pan left/right/up/down" → that action. Chart left/right is mirrored
  versus a ground map (you're inside the sphere) — the panel handles it;
  just pass the user's words.
- **"where is Mars" / "show me Orion" / "find Vega"** → `goto {target}`.
  The wall resolves planets, the Sun, the Moon, ~150 named stars, and all
  88 constellations by name and flies there. Anything dimmer or deep-sky
  (M31, a comet): `goto {ra, dec}` from your own knowledge.
- "look east" / "face north" → `goto {az: 90, alt: 25}` (E=90 S=180 W=270).
- fov on goto: 60 is a constellation, 25 a close-up, 180 the whole dome.

Time verbs (the sky's own axis — this is what makes the panel):

- "what will the sky look like at midnight" → `set_time {time: ISO}`.
- "tomorrow night" / "go back an hour" → `advance_time {hours: 24 / -1}`.
- "back to now" → `set_time` with no time.
- **"speed up time" / "watch the stars move"** → `timelapse {rate}`.
  600 (10 sim-min/s) shows wheeling stars; 3600 sweeps a night in ~24s.
  `rate: 0` stops. The HUD shows the simulated clock and a TIME chip.
- "follow the moon" / "track Jupiter" → `track {target}` — stays centered
  while time runs (great with a timelapse). `track` with no target stops.

Layers: "hide the constellation lines" / "turn labels off" →
`toggle {layer, on}`.

`sky_control` 409s if the panel isn't up — display it first, then steer.

## Voice

Astronomy invites one sentence more than usual, but stay the Computer:
what's up, where to look, one notable fact. "Jupiter is high in the
southeast, the brightest point in the sky. Orion is rising in the east."
For a goto, speak while the panel flies. Rise/set times you compute or
know approximately — say "about"; exact almanac numbers need checking.

## What this panel is not

- Pictures/photos of planets, nebulae, galaxies → `subjects` (show_image).
- "How far is Mars", orbital mechanics explainers → `diagrams` or `math`.
- Daytime weather sky ("will it be clear tonight?") → `weather`, though a
  clear-sky answer pairs well with offering this panel after.
