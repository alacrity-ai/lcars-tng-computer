---
name: timers
description: Timers and alarms — "set a timer for 10 minutes", "set an alarm for 2pm", "cancel/clear my timer", "how long is left on the timer". Spawns a widget badge overlaying the wall's top-left; the server fires it on time even while the session is idle.
---

# Timers & alarms

`set_timer` spawns a **widget** — an overlay badge stacked top-left on the
wall, independent of whatever panel is showing. It survives panel changes and
idle-revert. The **server** owns the countdown: when it fires — chime, spoken
announcement, badge flashes for a minute, then removes itself — you are not
involved and need not be running.

## Setting

- **"Set a timer for 10 minutes"** → `set_timer({kind: "timer", seconds: 600})`
- **"Set an alarm for 2pm"** → `set_timer({kind: "alarm", time: "14:00"})`
  — `time` is HH:MM, 24-hour, server-local; the server picks today or
  tomorrow itself. **Never compute seconds for an alarm** — you don't know
  the current wall-clock time; the server does.
- `label`: short badge text when there's a natural one ("TEA", "PASTA").
  Omit it otherwise — the badge falls back to TIMER/ALARM.
- `announce`: compose the sentence spoken at fire time — this is your voice
  arriving later, so write it as you'd say it: "Your tea is ready." /
  "It is two PM. Alarm." The fallback is a generic "Timer complete."

Confirm from the response's `fires` / `in` fields — "Timer set: ten minutes."
or "Alarm set for two PM." One sentence; no display call needed, the widget
IS the display.

## Clearing

- "Clear/cancel my alarm" → `clear_timer({})` — no id clears **all** timer
  and alarm widgets; right when only one is up.
- Several active → `screen_state` lists widgets with ids; clear the one
  meant: `clear_timer({id: "..."})`.
- A fired alarm still flashing → same `clear_timer` silences it.

## Status

"How long is left?" → `screen_state`; widgets carry `endsAt` (epoch ms) and
the response is authoritative. Speak the remaining time naturally.

## Conduct around active widgets

Widgets don't occupy the screen — carry on with anything else (panels, maps,
video) exactly as normal while they run. Don't mention an active timer
unprompted, and never sit waiting for one to fire: set it, confirm, move on.

Limit: 8 concurrent widgets (server 409s past that — say so and offer to
clear one).
