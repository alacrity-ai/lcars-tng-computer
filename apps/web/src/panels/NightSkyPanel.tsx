import { useEffect, useRef, useState } from "react";
import type { NightSkyPanelProps, SkyControlAction, SkyLayer } from "@tng/shared";
import { STARS, CONSTELLATION_LINES, CONSTELLATION_NAMES } from "../sky/catalog";
import { azDelta, project, raDecToAltAz, solarSystem, sunAltitude } from "../sky/astro";
import type { SkyBodyPos } from "../sky/astro";

/**
 * Live planetarium. The wall computes the whole sky itself — bundled
 * naked-eye star catalog, astronomy-engine ephemerides — so the panel needs
 * only an observer location and (optionally) a moment and a view direction.
 *
 * Voice control: "tng-sky-control" window events steer the live view in
 * place (zoom, pan, go-to, time travel, time-lapse, tracking, layer
 * toggles). After each settled change the view is announced via
 * "tng-sky-view" so the server's screen_state stays truthful — relative
 * commands always compose against where the sky actually is.
 *
 * Time model: simulated time = anchor + (real elapsed × rate). rate is 1
 * in normal viewing (the sky genuinely drifts, like the real one), larger
 * during a time-lapse, and the anchor jumps on set_time/advance_time.
 */

interface ViewState {
  az: number;
  alt: number;
  fov: number;
  /** Simulated-time anchor (epoch ms) and the real moment it was set. */
  anchorSim: number;
  anchorReal: number;
  rate: number;
  constellations: boolean;
  labels: boolean;
  planets: boolean;
  track: string | null;
}

interface FlyAnim {
  fromAz: number;
  fromAlt: number;
  fromFov: number;
  toAz: number;
  toAlt: number;
  toFov: number;
  start: number;
  ms: number;
}

const FOV_MIN = 10;
const FOV_MAX = 180;
const clampAlt = (v: number) => Math.min(90, Math.max(-20, v));
const clampFov = (v: number) => Math.min(FOV_MAX, Math.max(FOV_MIN, v));
const norm360 = (v: number) => ((v % 360) + 360) % 360;
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (1 - t) * (1 - t) * 2);

/** Case-insensitive object lookup: planet/Sun/Moon → live position; star or
    constellation → catalog ra/dec. Returns equatorial degrees or a body. */
function findTarget(
  name: string,
  bodies: SkyBodyPos[],
): { body?: SkyBodyPos; ra?: number; dec?: number } | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const body = bodies.find((b) => b.name.toLowerCase() === q);
  if (body) return { body };
  const star = STARS.find((s) => s[3]?.toLowerCase() === q);
  if (star) return { ra: star[0], dec: star[1] };
  const con = CONSTELLATION_NAMES.find((c) => c[0].toLowerCase() === q);
  if (con) return { ra: con[1], dec: con[2] };
  return null;
}

export function NightSkyPanel({
  lat,
  lng,
  title,
  time,
  azimuth = 180,
  altitude = 90,
  fov = 180,
  constellations = true,
  labels = true,
  planets = true,
}: NightSkyPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [shownTitle, setShownTitle] = useState(title);
  const [hud, setHud] = useState<{ clock: string; chips: string[] }>({ clock: "", chips: [] });

  // The requested view — a fresh display resets everything; voice nudges
  // mutate viewRef on the live instance instead.
  const displayKey = JSON.stringify([lat, lng, time, azimuth, altitude, fov]);

  const viewRef = useRef<ViewState | null>(null);
  const flyRef = useRef<FlyAnim | null>(null);

  useEffect(() => {
    if (typeof lat !== "number" || typeof lng !== "number") return;
    const requested = time ? Date.parse(time) : NaN;
    viewRef.current = {
      az: norm360(azimuth),
      alt: clampAlt(altitude),
      fov: clampFov(fov),
      anchorSim: Number.isFinite(requested) ? requested : Date.now(),
      anchorReal: Date.now(),
      rate: 1,
      constellations,
      labels,
      planets,
      track: null,
    };
    flyRef.current = null;
    setShownTitle(title);
    titleRef.current = title;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayKey]);

  const titleRef = useRef(title);

  // Announce the settled view so screen_state (and therefore relative voice
  // commands and history replay) reflect reality. Cheap enough to throttle
  // by caller discipline: discrete controls announce once, the time-lapse
  // loop announces every ~2s.
  const announce = () => {
    const v = viewRef.current;
    if (!v) return;
    window.dispatchEvent(
      new CustomEvent("tng-sky-view", {
        detail: {
          azimuth: Math.round(v.az * 10) / 10,
          altitude: Math.round(v.alt * 10) / 10,
          fov: Math.round(v.fov),
          time: new Date(simNow()).toISOString(),
          constellations: v.constellations,
          labels: v.labels,
          planets: v.planets,
          title: titleRef.current,
        },
      }),
    );
  };

  const simNow = () => {
    const v = viewRef.current;
    if (!v) return Date.now();
    return v.anchorSim + (Date.now() - v.anchorReal) * v.rate;
  };

  /** Re-anchor so a rate change doesn't teleport the simulated clock. */
  const setRate = (rate: number) => {
    const v = viewRef.current;
    if (!v) return;
    v.anchorSim = simNow();
    v.anchorReal = Date.now();
    v.rate = rate;
  };

  const flyTo = (toAlt: number, toAz: number, toFov?: number, ms = 1200) => {
    const v = viewRef.current;
    if (!v) return;
    flyRef.current = {
      fromAz: v.az,
      fromAlt: v.alt,
      fromFov: v.fov,
      toAz: v.az + azDelta(v.az, norm360(toAz)),
      toAlt: clampAlt(toAlt),
      toFov: clampFov(toFov ?? v.fov),
      start: performance.now(),
      ms,
    };
  };

  // ---- control events ------------------------------------------------------
  useEffect(() => {
    const onControl = (e: Event) => {
      const v = viewRef.current;
      if (!v) return;
      const d = ((e as CustomEvent).detail ?? {}) as {
        action?: SkyControlAction;
        amount?: number;
        target?: string;
        ra?: number;
        dec?: number;
        az?: number;
        alt?: number;
        fov?: number;
        title?: string;
        time?: string;
        hours?: number;
        rate?: number;
        layer?: SkyLayer;
        on?: boolean;
      };
      const n = typeof d.amount === "number" && d.amount > 0 ? Math.min(d.amount, 6) : 1;
      const panStep = v.fov * 0.4;
      switch (d.action) {
        case "zoom_in":
          flyTo(v.alt, v.az, v.fov * 0.65 ** n, 700);
          break;
        case "zoom_out":
          flyTo(v.alt, v.az, v.fov / 0.65 ** n, 700);
          break;
        // Screen-left is eastward of center (sky charts mirror ground maps),
        // so "left" increases azimuth. See project() in sky/astro.ts.
        case "left":
          flyTo(v.alt, v.az + panStep * n, undefined, 700);
          break;
        case "right":
          flyTo(v.alt, v.az - panStep * n, undefined, 700);
          break;
        case "up":
          flyTo(v.alt + panStep * n, v.az, undefined, 700);
          break;
        case "down":
          flyTo(v.alt - panStep * n, v.az, undefined, 700);
          break;
        case "goto": {
          if (d.title) {
            titleRef.current = d.title;
            setShownTitle(d.title);
          }
          v.track = null;
          const t = simNow();
          let dest: { alt: number; az: number } | null = null;
          if (d.target) {
            const hit = findTarget(d.target, solarSystem(lat, lng, new Date(t)));
            if (hit?.body) dest = { alt: hit.body.alt, az: hit.body.az };
            else if (hit) dest = raDecToAltAz(hit.ra!, hit.dec!, lat, lng, new Date(t));
          } else if (typeof d.ra === "number" && typeof d.dec === "number") {
            dest = raDecToAltAz(d.ra, d.dec, lat, lng, new Date(t));
          } else if (typeof d.az === "number" || typeof d.alt === "number") {
            dest = { az: d.az ?? v.az, alt: d.alt ?? v.alt };
          }
          if (dest) {
            // A named object deserves a closer look: default to 60° unless
            // the caller chose, or we're already tighter.
            const targetFov = d.fov ?? (d.target ? Math.min(v.fov, 60) : v.fov);
            flyTo(dest.alt, dest.az, targetFov, 1400);
          } else if (typeof d.fov === "number") {
            flyTo(v.alt, v.az, d.fov, 700);
          }
          break;
        }
        case "set_time": {
          const t = d.time ? Date.parse(d.time) : Date.now();
          if (Number.isFinite(t)) {
            v.anchorSim = t;
            v.anchorReal = Date.now();
            if (!d.time) v.rate = 1; // "back to now" also ends a time-lapse
          }
          break;
        }
        case "advance_time":
          if (typeof d.hours === "number" && Number.isFinite(d.hours)) {
            v.anchorSim = simNow() + d.hours * 3_600_000;
            v.anchorReal = Date.now();
          }
          break;
        case "timelapse":
          setRate(typeof d.rate === "number" && d.rate > 0 ? Math.min(d.rate, 86_400) : 1);
          break;
        case "track":
          v.track = d.target?.trim() ? d.target.trim() : null;
          if (v.track) {
            const hit = findTarget(v.track, solarSystem(lat, lng, new Date(simNow())));
            if (!hit) v.track = null;
            else {
              const p = hit.body ?? raDecToAltAz(hit.ra!, hit.dec!, lat, lng, new Date(simNow()));
              flyTo(p.alt, p.az, Math.min(v.fov, 60), 1400);
            }
          }
          break;
        case "toggle": {
          if (d.layer === "constellations") v.constellations = d.on ?? !v.constellations;
          else if (d.layer === "labels") v.labels = d.on ?? !v.labels;
          else if (d.layer === "planets") v.planets = d.on ?? !v.planets;
          break;
        }
      }
      announce();
    };
    window.addEventListener("tng-sky-control", onControl);
    return () => window.removeEventListener("tng-sky-control", onControl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  // ---- render loop ---------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof lat !== "number" || typeof lng !== "number") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let lastAnnounce = 0;
    let lastHud = "";

    const draw = () => {
      const v = viewRef.current;
      if (!v) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Fly animation
      const fly = flyRef.current;
      if (fly) {
        const t = Math.min(1, (performance.now() - fly.start) / fly.ms);
        const k = easeInOut(t);
        v.az = norm360(fly.fromAz + (fly.toAz - fly.fromAz) * k);
        v.alt = fly.fromAlt + (fly.toAlt - fly.fromAlt) * k;
        v.fov = fly.fromFov + (fly.toFov - fly.fromFov) * k;
        if (t >= 1) {
          flyRef.current = null;
          announce();
        }
      }

      const t = simNow();
      const date = new Date(t);
      const bodies = solarSystem(lat, lng, date);

      // Tracking: keep the tracked object centered (hard-lock once the
      // initial fly-to has landed).
      if (v.track && !flyRef.current) {
        const hit = findTarget(v.track, bodies);
        if (hit) {
          const p = hit.body ?? raDecToAltAz(hit.ra!, hit.dec!, lat, lng, date);
          v.az = p.az;
          v.alt = clampAlt(p.alt);
        }
      }

      // Sky background: black night → deep indigo twilight → muted slate day.
      const sunAlt = sunAltitude(lat, lng, date);
      const day = Math.min(1, Math.max(0, (sunAlt + 12) / 18)); // 0 below -12°, 1 above +6°
      const bg = (a: number, b: number) => Math.round(a + (b - a) * day);
      ctx.fillStyle = `rgb(${bg(1, 38)}, ${bg(3, 52)}, ${bg(10, 76)})`;
      ctx.fillRect(0, 0, w, h);
      const starDim = 1 - day * 0.85; // stars wash out as the sky brightens

      const P = (alt: number, az: number) => project(alt, az, v.alt, v.az, v.fov, w, h);
      const onCanvas = (p: { x: number; y: number }) =>
        p.x > -60 && p.x < w + 60 && p.y > -60 && p.y < h + 60;

      // Constellation figures
      if (v.constellations) {
        ctx.strokeStyle = `rgba(255, 153, 0, ${0.32 * starDim})`;
        ctx.lineWidth = 1.4;
        for (const seg of CONSTELLATION_LINES) {
          ctx.beginPath();
          let pen = false;
          for (const [ra, dec] of seg) {
            const aa = raDecToAltAz(ra, dec, lat, lng, date);
            const p = aa.alt > -12 ? P(aa.alt, aa.az) : null;
            if (p && onCanvas(p)) {
              if (pen) ctx.lineTo(p.x, p.y);
              else ctx.moveTo(p.x, p.y);
              pen = true;
            } else pen = false;
          }
          ctx.stroke();
        }
      }

      // Stars
      const showFaintLabels = v.fov < 70;
      for (const s of STARS) {
        const aa = raDecToAltAz(s[0], s[1], lat, lng, date);
        if (aa.alt < -1) continue;
        const p = P(aa.alt, aa.az);
        if (!p || !onCanvas(p)) continue;
        const mag = s[2];
        const r = Math.max(0.7, 3.6 - mag * 0.62);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        const bright = Math.min(1, (5.2 - mag) / 5) * starDim;
        ctx.fillStyle = `rgba(255, 240, 220, ${Math.max(0.06, bright)})`;
        ctx.fill();
        if (v.labels && s[3] && (mag <= 0.8 || (showFaintLabels && mag <= 2.2))) {
          ctx.fillStyle = `rgba(255, 204, 153, ${0.85 * starDim})`;
          ctx.font = "600 13px Antonio, 'Arial Narrow', sans-serif";
          ctx.fillText(s[3].toUpperCase(), p.x + r + 4, p.y + 4);
        }
      }

      // Constellation names
      if (v.constellations && v.labels && v.fov >= 45) {
        ctx.fillStyle = `rgba(153, 153, 255, ${0.5 * starDim})`;
        ctx.font = "600 14px Antonio, 'Arial Narrow', sans-serif";
        ctx.textAlign = "center";
        for (const [name, ra, dec] of CONSTELLATION_NAMES) {
          const aa = raDecToAltAz(ra, dec, lat, lng, date);
          if (aa.alt < 5) continue;
          const p = P(aa.alt, aa.az);
          if (p && onCanvas(p)) ctx.fillText(name.toUpperCase(), p.x, p.y);
        }
        ctx.textAlign = "left";
      }

      // Sun, Moon, planets
      if (v.planets) {
        for (const b of bodies) {
          if (b.alt < -1) continue;
          const p = P(b.alt, b.az);
          if (!p || !onCanvas(p)) continue;
          if (b.name === "Sun") {
            const grad = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 34);
            grad.addColorStop(0, "rgba(255, 236, 180, 1)");
            grad.addColorStop(1, "rgba(255, 170, 60, 0)");
            ctx.fillStyle = grad;
            ctx.fillRect(p.x - 34, p.y - 34, 68, 68);
            ctx.beginPath();
            ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
            ctx.fillStyle = "#fff2cc";
            ctx.fill();
          } else if (b.name === "Moon") {
            // Angular diameter ≈ 0.52° of the vertical field, floored so the
            // Moon never vanishes in the all-sky view.
            const rMoon = Math.max(7, (0.52 / v.fov) * h * 0.55);
            const f = b.phaseFraction ?? 1;
            const dir = b.waxing ? -1 : 1; // lit limb: waxing = evening/west side
            ctx.save();
            ctx.beginPath();
            ctx.arc(p.x, p.y, rMoon, 0, Math.PI * 2);
            ctx.fillStyle = "rgba(120, 125, 140, 0.55)"; // earthshine disc
            ctx.fill();
            // Lit portion: half-disc + phase ellipse.
            ctx.beginPath();
            ctx.arc(p.x, p.y, rMoon, Math.PI / 2, -Math.PI / 2, dir === -1);
            ctx.ellipse(p.x, p.y, rMoon * Math.abs(2 * f - 1), rMoon, 0, -Math.PI / 2, Math.PI / 2, (f < 0.5) === (dir === -1));
            ctx.fillStyle = "#f4f1e8";
            ctx.fill();
            ctx.restore();
            if (v.labels) {
              ctx.fillStyle = "rgba(255, 204, 153, 0.9)";
              ctx.font = "600 14px Antonio, 'Arial Narrow', sans-serif";
              ctx.fillText("MOON", p.x + rMoon + 6, p.y + 5);
            }
          } else {
            const r = Math.max(2.4, 5 - b.mag);
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fillStyle = "#ffcc66";
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 204, 102, 0.35)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r + 3.5, 0, Math.PI * 2);
            ctx.stroke();
            if (v.labels) {
              ctx.fillStyle = "rgba(255, 204, 153, 0.95)";
              ctx.font = "600 14px Antonio, 'Arial Narrow', sans-serif";
              ctx.fillText(b.name.toUpperCase(), p.x + r + 6, p.y + 5);
            }
          }
        }
      }

      // Horizon line + cardinal marks
      ctx.strokeStyle = "rgba(255, 153, 0, 0.55)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      let pen = false;
      for (let az = 0; az <= 360; az += 2) {
        const p = P(0, az);
        if (p && onCanvas(p)) {
          if (pen) ctx.lineTo(p.x, p.y);
          else ctx.moveTo(p.x, p.y);
          pen = true;
        } else pen = false;
      }
      ctx.stroke();
      const cardinals: [string, number][] = [
        ["N", 0], ["NE", 45], ["E", 90], ["SE", 135],
        ["S", 180], ["SW", 225], ["W", 270], ["NW", 315],
      ];
      ctx.textAlign = "center";
      for (const [label, az] of cardinals) {
        const p = P(1.5, az);
        if (!p || !onCanvas(p)) continue;
        ctx.font = `700 ${label.length === 1 ? 20 : 15}px Antonio, 'Arial Narrow', sans-serif`;
        ctx.fillStyle = "rgba(255, 204, 102, 0.9)";
        ctx.fillText(label, p.x, p.y);
      }
      ctx.textAlign = "left";

      // HUD (DOM chips) — update only when the strings change.
      const clock = date.toLocaleString([], {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const chips: string[] = [];
      if (v.rate !== 1) chips.push(`TIME ×${Math.round(v.rate)}`);
      if (v.track) chips.push(`TRACKING ${v.track.toUpperCase()}`);
      if (sunAlt > -6) chips.push("DAYLIGHT");
      const hudKey = clock + chips.join("|");
      if (hudKey !== lastHud) {
        lastHud = hudKey;
        setHud({ clock, chips });
      }

      // Keep screen_state truthful during a running time-lapse.
      if (v.rate !== 1 && performance.now() - lastAnnounce > 2000) {
        lastAnnounce = performance.now();
        announce();
      }

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    announce();
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayKey, lat, lng]);

  if (typeof lat !== "number" || typeof lng !== "number") {
    return <div className="text-panel-body">Night sky requires an observer location.</div>;
  }

  return (
    <div className="sky-panel">
      {shownTitle && <div className="sky-title">{shownTitle}</div>}
      <div className="sky-frame">
        <canvas ref={canvasRef} className="sky-canvas" />
        <div className="sky-hud">
          <span className="sky-hud-clock">{hud.clock}</span>
          {hud.chips.map((c) => (
            <span key={c} className="sky-hud-chip">
              {c}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
