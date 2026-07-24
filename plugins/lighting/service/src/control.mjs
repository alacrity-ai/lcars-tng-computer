// Target resolution + Zigbee2MQTT command building.
//
// Friendly-name convention (HSHLD-1): "room/fixture" — living-room/ceiling,
// kitchen/counter-1 — with a native Zigbee group per room named after the
// room, plus an optional house-wide "all-lights" group. Commands prefer ONE
// publish per zone: the group topic when a group exists; fanning out to
// individual fixtures is only the fallback before groups are formed.

export const SCENES = {
  evening: { state: "on", brightness: 40, colorTemp: 2700, transition: 2 },
  movie: { state: "on", brightness: 12, colorTemp: 2700, transition: 3 },
  "all-off": { state: "off", transition: 2 },
  "red-alert": { state: "on", brightness: 100, color: "red", transition: 0.5 },
};

const COLOR_NAMES = {
  red: "#ff0000",
  orange: "#ff8000",
  amber: "#ffbf00",
  yellow: "#ffff00",
  green: "#00ff00",
  teal: "#00ffbf",
  cyan: "#00ffff",
  blue: "#0000ff",
  lavender: "#b57edc",
  purple: "#8000ff",
  magenta: "#ff00ff",
  pink: "#ff69b4",
  white: "#ffffff",
  "warm-white": "#ffd8a8",
};

export function normalize(s) {
  // "Ariel's Studio" must find "ariels-studio": hyphenate whitespace, then
  // drop punctuation entirely (keep / for fixtures, # for hex, * for all).
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9/#*-]/g, "");
}

export function miredsToKelvin(ct) {
  return Math.round(1_000_000 / ct);
}

/**
 * Map a spoken/typed target onto MQTT topics. Returns
 * { kind, topics: [friendly names], label } or null when nothing matches.
 */
export function resolveTargets(cache, raw) {
  const groups = cache.groups.map((g) => g.friendly_name).filter(Boolean);
  const devices = cache.devices.map((d) => d.friendly_name).filter(Boolean);
  const n = normalize(raw || "all");

  if (["all", "everything", "all-lights", "house", "*"].includes(n)) {
    const allGroup = groups.find((g) => normalize(g) === "all-lights");
    if (allGroup) return { kind: "group", topics: [allGroup], label: "all lights" };
    if (groups.length) return { kind: "groups", topics: groups, label: "all zones" };
    if (devices.length) return { kind: "devices", topics: devices, label: "all fixtures" };
    return null;
  }
  const g = groups.find((x) => normalize(x) === n);
  if (g) return { kind: "group", topics: [g], label: g };
  const d = devices.find((x) => normalize(x) === n);
  if (d) return { kind: "device", topics: [d], label: d };
  // Room prefix with no native group yet — fan out (see convention note).
  const room = devices.filter((x) => normalize(x).startsWith(`${n}/`));
  if (room.length) return { kind: "devices", topics: room, label: raw };
  // Bare fixture name, unambiguous ("ceiling" → living-room/ceiling).
  const suffix = devices.filter((x) => normalize(x).endsWith(`/${n}`));
  if (suffix.length === 1) return { kind: "device", topics: suffix, label: suffix[0] };
  return null;
}

export function knownNames(cache) {
  return [
    ...cache.groups.map((g) => g.friendly_name),
    ...cache.devices.map((d) => d.friendly_name),
  ].filter(Boolean);
}

/**
 * Build the Z2M /set payload from friendly fields. Returns the payload, or
 * { error } on bad input. Brightness is PERCENT here (0–100); Z2M wants
 * 0–254. colorTemp takes kelvin (≥1000), mireds (<1000), or warm|neutral|cool.
 */
export function buildCommand(body = {}) {
  const out = {};
  const st = typeof body.state === "string" ? body.state.toLowerCase() : undefined;
  if (st === "on") out.state = "ON";
  else if (st === "off") out.state = "OFF";
  else if (st !== undefined) return { error: 'state must be "on" or "off"' };

  if (body.brightness !== undefined) {
    const p = Number(body.brightness);
    if (!Number.isFinite(p) || p < 0 || p > 100) return { error: "brightness must be 0..100 (percent)" };
    if (p === 0) out.state = "OFF";
    else {
      out.brightness = Math.max(1, Math.round((p * 254) / 100));
      if (!out.state) out.state = "ON"; // dimming implies on — be explicit
    }
  }
  if (body.colorTemp !== undefined) {
    const k =
      typeof body.colorTemp === "string"
        ? { warm: 2700, neutral: 4000, cool: 6500 }[normalize(body.colorTemp)]
        : Number(body.colorTemp);
    if (!Number.isFinite(k)) return { error: "colorTemp must be kelvin (2200..6500) or warm|neutral|cool" };
    const mireds = k >= 1000 ? Math.round(1_000_000 / k) : Math.round(k);
    out.color_temp = Math.min(500, Math.max(153, mireds));
  }
  if (body.color !== undefined) {
    const c = normalize(body.color);
    const hex = COLOR_NAMES[c] ?? (/^#?[0-9a-f]{6}$/.test(c) ? (c.startsWith("#") ? c : `#${c}`) : null);
    if (!hex) {
      return { error: `unknown color "${body.color}" — use a name (${Object.keys(COLOR_NAMES).join(", ")}) or #rrggbb` };
    }
    out.color = { hex };
  }
  if (Object.keys(out).length === 0) return { error: "nothing to do — give state, brightness, colorTemp, or color" };

  // Every change fades by default — instant snaps read as a fault, not a cue.
  const t = body.transition === undefined ? 1.5 : Number(body.transition);
  if (Number.isFinite(t) && t >= 0) out.transition = Math.min(60, t);
  return out;
}
