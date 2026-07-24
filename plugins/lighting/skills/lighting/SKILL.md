---
name: lighting
description: Voice control of the household Zigbee lights — routing "dim/brighten X", "warm/cool light", on/off, colors, scenes (movie mode, all off, red alert), "are the lights on", and "show me the lights" to the lights tool.
---

# Lighting

The house has a local Zigbee lighting fabric (no cloud). One tool drives all
of it: `lights` (from the lighting plugin). Fixtures are named
`room/fixture` (`living-room/ceiling`); rooms are zones — one command per
zone, the fabric handles the rest.

## Routing

| The human says | Call |
|---|---|
| "turn on/off the living room lights" | `lights action:"on"/"off" target:"living-room"` |
| "dim the kitchen to 30%" | `lights action:"set" target:"kitchen" brightness:30` |
| "brighter in here" (room known from context) | `set` with brightness ~25 points up from status |
| "warmer / cooler light" | `set` with `colorTemp:"warm"` / `"cool"` (or kelvin 2200–6500) |
| "make the lights red / amber / #ff8800" | `set` with `color` — back to white via `colorTemp` |
| "movie mode" / "evening lights" / "all off" / "red alert" | `lights action:"scene" scene:"movie"/"evening"/"all-off"/"red-alert"` |
| "party mode" / "disco" | `lights action:"scene" scene:"party"` — colorloop; stop it with `set effect:"stop_colorloop"` (then restore a colorTemp) |
| "flash/blink the lights" (attention cue) | `lights action:"set" target:... effect:"blink"` — momentary, state untouched |
| "make them pulse/breathe" | `set` with `effect:"breathe"` |
| "are the kitchen lights on?" / "what lights are on?" | `lights action:"status"` — answer from it, no probing |
| "show me the lights" | `lights action:"panel"` — the LIGHTING dashboard; it self-refreshes while on screen |

Omit `target` for the whole house. Transitions default to a 1.5 s fade —
only pass `transition` when the human asks for instant or extra-slow.

## Judgment

- **Status is cached and instant** — call it freely to answer questions or
  ground a relative change ("a bit dimmer"). Never say you'll "check the
  bulbs"; you already know.
- Relative changes: ±20–25 brightness points feels like one spoken step.
- "Goodnight"-type requests → scene `all-off`, not per-room commands.
- If the tool answers **"Lighting control is offline."** — say exactly that,
  once, and stop. No retry loops, no speculation about why.
- A target the tool rejects comes back with the known names — offer those,
  don't guess again blind.
- Pairing new bulbs is an operator task (Zigbee2MQTT console), not yours —
  if asked, say the pairing console is on the host at port 8092.
