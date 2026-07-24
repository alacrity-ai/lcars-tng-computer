/**
 * Sky-panel astronomy: equatorial → horizontal conversion and the
 * stereographic projection the canvas draws with.
 *
 * Star positions use the classic GMST + hour-angle transform (fast enough to
 * run over the whole catalog every animation frame); planets, the Moon, and
 * the Sun go through astronomy-engine, which handles their actual orbits.
 */
import { Body, Equator, Illumination, MakeTime, Observer, SiderealTime } from "astronomy-engine";

const DEG = Math.PI / 180;

export interface AltAz {
  /** Degrees above the horizon (negative = below). */
  alt: number;
  /** Degrees from north, increasing eastward, 0–360. */
  az: number;
}

/** Equatorial (of-date is close enough for J2000 catalog stars at wall scale)
    → horizontal, for an observer at lat/lng at `date`. */
export function raDecToAltAz(
  raDeg: number,
  decDeg: number,
  latDeg: number,
  lngDeg: number,
  date: Date,
): AltAz {
  // Local sidereal time in degrees: Greenwich apparent sidereal time + east longitude.
  const lstDeg = SiderealTime(date) * 15 + lngDeg;
  const H = (lstDeg - raDeg) * DEG; // hour angle, positive west
  const lat = latDeg * DEG;
  const dec = decDeg * DEG;
  const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const alt = Math.asin(Math.min(1, Math.max(-1, sinAlt)));
  // Azimuth from north, eastward positive.
  const y = -Math.cos(dec) * Math.sin(H);
  const x = Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.cos(H) * Math.sin(lat);
  let az = Math.atan2(y, x) / DEG;
  if (az < 0) az += 360;
  return { alt: alt / DEG, az };
}

export interface SkyBodyPos extends AltAz {
  body: Body;
  name: string;
  /** Visual magnitude (Sun/Moon get symbolic values). */
  mag: number;
  /** Moon only: illuminated fraction 0–1. */
  phaseFraction?: number;
  /** Moon only: true when waxing (lit limb faces west). */
  waxing?: boolean;
}

const PLANETS: [Body, string][] = [
  [Body.Mercury, "Mercury"],
  [Body.Venus, "Venus"],
  [Body.Mars, "Mars"],
  [Body.Jupiter, "Jupiter"],
  [Body.Saturn, "Saturn"],
];

/** Sun, Moon, and naked-eye planets in horizontal coordinates at `date`. */
export function solarSystem(latDeg: number, lngDeg: number, date: Date): SkyBodyPos[] {
  const time = MakeTime(date);
  const observer = new Observer(latDeg, lngDeg, 0);
  const out: SkyBodyPos[] = [];
  const place = (body: Body, name: string): SkyBodyPos => {
    const eq = Equator(body, time, observer, true, true);
    const pos = raDecToAltAz(eq.ra * 15, eq.dec, latDeg, lngDeg, date);
    return { body, name, mag: 0, ...pos };
  };
  const sun = place(Body.Sun, "Sun");
  sun.mag = -26.7;
  out.push(sun);
  const moon = place(Body.Moon, "Moon");
  const illum = Illumination(Body.Moon, time);
  moon.mag = illum.mag;
  moon.phaseFraction = illum.phase_fraction;
  // Ecliptic phase angle < 180° = waxing (0 new → 180 full → 360 new).
  moon.waxing = illum.phase_angle < 180 ? true : false;
  out.push(moon);
  for (const [body, name] of PLANETS) {
    const p = place(body, name);
    p.mag = Illumination(body, time).mag;
    out.push(p);
  }
  return out;
}

/** Sun altitude only — drives the twilight sky tint. */
export function sunAltitude(latDeg: number, lngDeg: number, date: Date): number {
  const eq = Equator(Body.Sun, MakeTime(date), new Observer(latDeg, lngDeg, 0), true, true);
  return raDecToAltAz(eq.ra * 15, eq.dec, latDeg, lngDeg, date).alt;
}

/**
 * Stereographic projection of an alt/az point onto a canvas whose view is
 * centered at (centerAz, centerAlt) with vertical field of view fovDeg.
 * Returns null for points on the far hemisphere (angular distance > 100°).
 * X grows LEFTWARD for eastward azimuth: we look at the sky from inside the
 * sphere, so a correct chart is mirrored versus a ground map.
 */
export function project(
  alt: number,
  az: number,
  centerAlt: number,
  centerAz: number,
  fovDeg: number,
  width: number,
  height: number,
): { x: number; y: number } | null {
  const a = alt * DEG;
  const a0 = centerAlt * DEG;
  const dAz = (az - centerAz) * DEG;
  const cosC = Math.sin(a0) * Math.sin(a) + Math.cos(a0) * Math.cos(a) * Math.cos(dAz);
  if (cosC < -0.17) return null; // > ~100° away — outside any sane view
  const k = 2 / (1 + cosC);
  const px = k * Math.cos(a) * Math.sin(dAz);
  const py = k * (Math.cos(a0) * Math.sin(a) - Math.sin(a0) * Math.cos(a) * Math.cos(dAz));
  // Half the vertical fov maps to half the canvas height (stereographic radius
  // for angular distance c is 2·tan(c/2)).
  const scale = height / 2 / (2 * Math.tan((fovDeg / 4) * DEG));
  return { x: width / 2 - px * scale, y: height / 2 - py * scale };
}

/** Great-circle-ish shortest signed difference between two azimuths, degrees. */
export function azDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
