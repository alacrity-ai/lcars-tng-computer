#!/usr/bin/env node
// Generate placeholder earcons (complete/error/red-alert) as 16-bit mono WAVs.
// acknowledge.mp3 is the real TNG beep; regenerate these anytime with:
//   node scripts/gen-earcons.mjs
// Swap in real TNG SFX later by dropping files over apps/web/public/sounds/*.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const RATE = 44100;
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../apps/web/public/sounds");

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-1, Math.min(1, s)) * 32767, i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** tone with attack/release envelope; freq may be a function of progress 0..1 */
function tone(durMs, freq, { gain = 0.5, shape = Math.sin } = {}) {
  const n = Math.floor((RATE * durMs) / 1000);
  const out = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = typeof freq === "function" ? freq(t) : freq;
    phase += (2 * Math.PI * f) / RATE;
    const env = Math.min(1, t / 0.08, (1 - t) / 0.15);
    out[i] = shape(phase) * env * gain;
  }
  return out;
}

const silence = (ms) => new Float64Array(Math.floor((RATE * ms) / 1000));
const concat = (...parts) => {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float64Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

mkdirSync(OUT, { recursive: true });

// complete: bright ascending double chirp
writeFileSync(join(OUT, "complete.wav"), wav(concat(tone(90, 660), silence(35), tone(150, 990))));

// error: low double buzz
const buzz = (t) => Math.sign(Math.sin(t)) * 0.7 + Math.sin(t) * 0.3; // square-ish
writeFileSync(
  join(OUT, "error.wav"),
  wav(concat(tone(140, 196, { shape: buzz, gain: 0.35 }), silence(60), tone(200, 165, { shape: buzz, gain: 0.35 }))),
);

// red-alert: two klaxon sweeps (rise-fall)
const sweep = tone(700, (t) => 440 + 440 * Math.sin(Math.PI * t), { gain: 0.45 });
writeFileSync(join(OUT, "red-alert.wav"), wav(concat(sweep, silence(80), sweep)));

console.log("earcons written to", OUT);
