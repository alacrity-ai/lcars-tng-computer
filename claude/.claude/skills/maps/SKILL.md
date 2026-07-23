---
name: maps
description: Showing and steering the map panel — "show me X", "where is X", "zoom in/out", "pan north", "go to X" for any place, region, sea, mountain, city, or landmark. Covers zoom levels, when to place markers, and steering a map that is already on screen rather than redrawing it.
---

# Maps

"Show me the Mediterranean" / "where is Mount Kilimanjaro" / "show me the Burj
Khalifa" → the `map` panel. You know the coordinates of almost every place; no
lookup needed.

```
display({ view: "map", props: {
  title: "Mount Kilimanjaro",
  lat: -3.0674, lng: 37.3556, zoom: 11,
  markers: [{ lat: -3.0674, lng: 37.3556, label: "Kilimanjaro" }]
}})
```

Note `lat` then `lng` here. (The OSRM router in the `directions` skill takes
them the other way round — don't carry that habit over.)

## Zoom guide

| Subject | Zoom |
|---|---|
| Ocean, continent | 3–4 |
| Sea, large country | 5–6 |
| Region, state | 7 |
| Island, metro area | 8–9 |
| City | 11 |
| Neighborhood | 13 |
| Landmark, building | 16–17 |

## Markers

- **Point places** — mountains, buildings, cities — get one labeled marker.
- **Regions and seas** get none. The framing *is* the answer; a marker in the
  middle of the Mediterranean says nothing.

## Steering a map that's already up

Use `map_control`, **not** a new `display` — a redraw throws away the view and
loses the animation.

- "zoom in / out" → `zoom_in` / `zoom_out`. `amount` is in zoom steps
  (default 1); "zoom way in" ≈ 3.
- "go west", "pan north" → `north` / `south` / `east` / `west`; `amount` is in
  half-viewport steps.
- **"Go to <place>"** → action `goto` with the destination's `lat`/`lng`, a
  `zoom` for the right altitude, and a `title`. The map flies there in a
  cinematic arc from wherever it currently is. Prefer this over a fresh
  `display` whenever a map is already showing.

`map_control` returns 409 if no map is displayed — then `display` one first.

Only use a new `display` when you need different markers, or no map is up.

## Two-step requests

"Show me Iran, then zoom into the capital" is one request with two beats. Do
them as two beats:

1. `display` the country at zoom 5
2. `speak` one orienting sentence — this blocks, which gives the wide view
   time to actually be seen
3. `map_control goto` the capital at zoom 11
4. `speak` about the capital

Firing both map calls back to back collapses the sequence into a single
invisible jump.

## Speaking

One orienting sentence — what the place is and what it's near. Never narrate
coordinates.

> "Kilimanjaro, in northern Tanzania near the Kenyan border — the highest peak
> in Africa."

## Screen state

The map keeps `screen_state` current as it moves, so `screen_state` always
reports where the view actually is — useful after a run of relative pans.

## "What is that feature?" — naming things near the view

Deictic questions — "what's that body of water to the south?", "what mountain
is that?" — are answered with ONE Overpass radius query around a reference
point, never by guessing names and geocoding the guesses.

1. **Reference point**: the marker/center you displayed; if the map has been
   panned, take the live center from `screen_state`.
2. **Radius from zoom**: street level (≥13) ≈ 2 km; city (11) ≈ 5 km;
   region (7–9) ≈ 20 km.
3. **One query, hard timeout, mirror fallback.** Only these three hosts are
   on the egress allowlist — anything else is rejected instantly by the
   container firewall (that's the fence, not an outage; a developer can widen
   `docker/allowed-domains.txt` from the host):

```bash
Q='[out:json][timeout:8];(
  way["natural"~"water|peak|bay|beach|wood"]["name"](around:R,LAT,LNG);
  relation["natural"~"water"]["name"](around:R,LAT,LNG);
  way["landuse"="reservoir"]["name"](around:R,LAT,LNG);
  way["leisure"~"park|nature_reserve"]["name"](around:R,LAT,LNG);
  node["place"]["name"](around:R,LAT,LNG);
  way["waterway"~"river|canal"]["name"](around:R,LAT,LNG);
);out tags center;'
for host in overpass-api.de overpass.kumi.systems overpass.private.coffee; do
  curl -s --max-time 10 "https://$host/api/interpreter" --data-urlencode "data=$Q" && break
done
```

   **Every curl gets `--max-time`.** First non-empty JSON wins. (Mirrors are
   best-effort public infrastructure — a healthy answer takes ~1-3s, an
   overloaded one may need the full budget.)
4. **Honor direction words with bearing math**, not proximity alone: bearing
   from the reference point to each candidate's `center` (θ = atan2 of the
   lat/lng deltas, cos-corrected); "south" means 135°–225°, and likewise for
   the other quadrants. Among matches, nearest wins.
5. Last resort only (Overpass empty on all mirrors): Nominatim lookup of a
   *specific* candidate name you have real grounds for — never a guessing
   loop.

If these mirrors prove flaky in practice, the planned upgrade is a local
GeoNames gazetteer baked into the stack (precedent: the yt-dlp bake) exposed
as a `nearby-features` lookup — sub-second and offline. Note it to the
developer if you hit repeated Overpass failures; don't build it mid-answer.
