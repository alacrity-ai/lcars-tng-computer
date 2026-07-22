#!/usr/bin/env python3
"""Generate apps/web/src/sky/catalog.ts from HYG + d3-celestial data.

Usage: download the three source files into the working directory, then
    python3 scripts/gen-sky-catalog.py apps/web/src/sky/catalog.ts

Sources:
    hyg.csv       https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv
    conlines.json https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json
    connames.json https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.json

Stars: HYG database, mag <= 4.6 (plus anything with a proper name up to 5.0).
Lines: d3-celestial constellations.lines.json (ra normalized to 0-360).
Names: d3-celestial constellations.json label points.
"""
import csv, json, sys

OUT = sys.argv[1]

stars = []
with open("hyg.csv", newline="") as f:
    for row in csv.DictReader(f):
        if row["id"] == "0":  # Sol
            continue
        try:
            mag = float(row["mag"])
            ra = float(row["ra"]) * 15.0  # hours -> degrees
            dec = float(row["dec"])
        except ValueError:
            continue
        name = (row["proper"] or "").strip()
        if mag <= 4.6 or (name and mag <= 5.0):
            stars.append((round(ra, 2), round(dec, 2), round(mag, 1), name))
stars.sort(key=lambda s: s[2])

with open("conlines.json") as f:
    lines_geo = json.load(f)
polylines = []
for feat in lines_geo["features"]:
    geom = feat["geometry"]
    coords = geom["coordinates"]
    if geom["type"] == "LineString":
        coords = [coords]
    for seg in coords:
        polylines.append([[round(ra % 360.0, 2), round(dec, 2)] for ra, dec in seg])

with open("connames.json") as f:
    names_geo = json.load(f)
con_names = []
for feat in names_geo["features"]:
    p = feat.get("properties", {})
    name = p.get("name") or p.get("n")
    coords = feat.get("geometry", {}).get("coordinates")
    if name and coords:
        con_names.append((name, round(coords[0] % 360.0, 1), round(coords[1], 1)))

def star_lit(s):
    ra, dec, mag, name = s
    return f'[{ra},{dec},{mag},{json.dumps(name)}]' if name else f'[{ra},{dec},{mag}]'

with open(OUT, "w") as f:
    f.write(
        "// GENERATED — do not edit by hand. Source: HYG star database v4.1\n"
        "// (astronexus/HYG-Database, CC BY-SA) filtered to naked-eye stars, and\n"
        "// d3-celestial constellation lines/names (ofrohn/d3-celestial, BSD-3).\n"
        "// Regenerate with docs/sops assets script if the cut ever changes.\n\n"
        "/** [raDeg 0-360, decDeg, magnitude, properName?] */\n"
        "export type CatalogStar = [number, number, number, string?];\n\n"
    )
    f.write("export const STARS: CatalogStar[] = [\n")
    for s in stars:
        f.write(f"  {star_lit(s)},\n")
    f.write("];\n\n")
    f.write("/** Constellation figure segments: polylines of [raDeg, decDeg] vertices. */\n")
    f.write("export const CONSTELLATION_LINES: [number, number][][] = [\n")
    for seg in polylines:
        f.write("  " + json.dumps(seg) + ",\n")
    f.write("];\n\n")
    f.write("/** Constellation label anchors: [name, raDeg, decDeg]. */\n")
    f.write("export const CONSTELLATION_NAMES: [string, number, number][] = [\n")
    for name, ra, dec in con_names:
        f.write(f"  [{json.dumps(name)},{ra},{dec}],\n")
    f.write("];\n")

print(f"stars={len(stars)} segments={len(polylines)} names={len(con_names)}")
