---
name: directions
description: Driving directions and routing between two places — "directions from A to B", "how do I get to X", "how far is X from here", "how long does it take to drive to X". Geocodes both endpoints and computes a real turn-by-turn route. Use whenever a request involves travel between locations; do NOT guess roads or distances from memory.
---

# Directions

Two public, unauthenticated APIs do all the work. Never estimate a route from
memory — fabricating turn-by-turn for a real address is worse than saying you
can't route.

## 1. Geocode both endpoints — Nominatim

```
https://nominatim.openstreetmap.org/search?q=<url-encoded address>&format=json&limit=3
```

WebFetch it with a prompt like *"Return the lat and lon values and display_name
for each result exactly as given."*

**Sanity-check the `display_name`** before using a result. It names the town,
county, and state — if those don't match what the user asked for, you geocoded
the wrong place. Ambiguous or missing results: retry with more qualification
("Litchfield Circle, Pelham, NH 03076" rather than "Litchfield Circle").

Both endpoints can be geocoded in parallel — two WebFetch calls in one block.

## 2. Route it — OSRM

```
https://router.project-osrm.org/route/v1/driving/{lng1},{lat1};{lng2},{lat2}?overview=false&steps=true
```

**Coordinate order is `lng,lat` — longitude FIRST.** This is backwards from
Nominatim's output, from the `map` panel, and from how you'd say it aloud. Get
it wrong and you route somewhere in the Indian Ocean, usually without an error.

Prompt: *"Give the total distance in meters and duration in seconds. Then list
each step's maneuver type, modifier, street name, and distance in order."*

Conversions: metres ÷ 1609.34 = miles · seconds ÷ 60 = minutes.

## 3. Read the step list correctly

OSRM emits a maneuver `type` per step. The one that trips people up:

- **`new name`** — the road continues and changes name. **This is not a turn.**
  Several consecutive `new name` steps are one continuous stretch of driving.
- `turn` with a `modifier` (left / right / slight left) — an actual turn.
- `depart` / `arrive` — endpoints; `arrive` carries the final side of the road.

Collapse `new name` runs when speaking. "Stay straight as it becomes University,
Textile, then Donahue" — not five separate instructions.

## 4. Present it

`display` the **`text`** panel, then `speak`. Directions are read, not heard —
the panel is the primary artifact here.

Put distance and time in the title:

```
display({ view: "text", props: {
  title: "116 Merrimack St, Lowell → 11 Litchfield Cir, Pelham — 6.6 mi, 14 min",
  body: "1.  Depart west on MERRIMACK ST — 0.8 mi\n\n2.  Continues as UNIVERSITY AVE — 0.8 mi\n..."
}})
```

- Number every step; street names in CAPS scan well on a wall.
- Blank line between steps — this panel is read from across a room.
- Note river crossings and state lines in parentheses; they're good landmarks.
- Add a closing line noting which steps are name-changes rather than turns.
- Keep the body under ~1,200 characters. Long routes: collapse aggressively,
  don't shrink the type.

Spoken: total distance and time first, then the route as three or four beats
("out through Lowell, up Nashua Road, right on Sherburne"). Never read the
step list aloud.

## 5. Always state the traffic caveat

OSRM returns **free-flow time with no live traffic**. The quoted duration is a
floor, not an estimate. Say so — in the panel footer and, if the route crosses
a known chokepoint at a plausible commute hour, out loud.

## Showing the route on the map

The `map` panel draws markers, not route lines. When geography matters more
than the turns ("how far is X from Y"), show the map with a marker on each
endpoint and a zoom that frames both — then speak the distance. When the user
asked for *directions*, the text panel wins; offer the map as a follow-up
rather than replacing the steps with it.

## Failure modes

- Nominatim returns nothing → say the address didn't resolve and ask for a
  cross-street or town. Don't route to a guess.
- OSRM errors or returns no route → chime `error`, say routing is unavailable,
  offer the straight-line distance from the two geocodes instead.
