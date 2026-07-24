// What color is the bulb, as a hex chip. Z2M reports color in whichever
// space the bulb last used — color_temp (mireds), hs {hue, saturation}, or
// CIE xy {x, y} — so the panel needs all three converted to sRGB. These are
// display approximations for a 44px swatch, not colorimetry.

const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v)));

export function rgbToHex(r, g, b) {
  return `#${[r, g, b].map((v) => clamp255(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Blackbody white — Tanner Helland's approximation. */
export function kelvinToHex(kelvin) {
  const t = Math.max(1000, Math.min(12000, kelvin)) / 100;
  let r;
  let g;
  let b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * (t - 60) ** -0.1332047592;
    g = 288.1221695283 * (t - 60) ** -0.0755148492;
    b = 255;
  }
  return rgbToHex(r, g, b);
}

/** Z2M hs: hue 0–360, saturation 0–100. Full value — brightness has its own gauge. */
export function hsToHex(hue, saturation) {
  const h = ((hue % 360) + 360) % 360;
  const s = Math.max(0, Math.min(100, saturation)) / 100;
  const c = s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = 1 - c;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/** CIE xy → sRGB (Wide-gamut matrix per Philips Hue's developer docs). */
export function xyToHex(x, y) {
  if (!(y > 0)) return "#ffffff";
  const Y = 1;
  const X = (Y / y) * x;
  const Z = (Y / y) * (1 - x - y);
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.01153;
  const gamma = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  [r, g, b] = [r, g, b].map((v) => gamma(Math.max(0, v)));
  const max = Math.max(r, g, b, 1e-6);
  if (max > 1) [r, g, b] = [r / max, g / max, b / max];
  return rgbToHex(r * 255, g * 255, b * 255);
}

/**
 * The bulb's current color from a Z2M state payload:
 * { hex, label } — label is what a human would call it ("4000K", "#FF0000").
 */
export function currentColor(state) {
  const mode = state.color_mode;
  const c = state.color ?? {};
  if (mode === "hs" && typeof c.hue === "number" && typeof c.saturation === "number") {
    const hex = hsToHex(c.hue, c.saturation);
    return { hex, label: hex.toUpperCase() };
  }
  if (mode === "xy" && typeof c.x === "number" && typeof c.y === "number") {
    const hex = xyToHex(c.x, c.y);
    return { hex, label: hex.toUpperCase() };
  }
  if (typeof state.color_temp === "number") {
    const kelvin = Math.round(1_000_000 / state.color_temp);
    return { hex: kelvinToHex(kelvin), label: `${kelvin}K` };
  }
  return null;
}
