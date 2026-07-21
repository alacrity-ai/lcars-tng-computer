import { randomUUID } from "node:crypto";
import type { CharTiming } from "@tng/shared";

/**
 * Client for the TTS sidecar (apps/tts) + an in-memory audio cache the
 * display fetches from. The sidecar is optional: when it's down, speak()
 * returns null and the display falls back to caption-only mode.
 */

const TTS_URL = process.env.TNG_TTS_URL ?? "http://127.0.0.1:3790";
const CACHE_MAX = 50;

const cache = new Map<string, Buffer>();

function put(id: string, audio: Buffer) {
  cache.set(id, audio);
  // FIFO eviction — utterances are played once, right after synthesis
  for (const key of cache.keys()) {
    if (cache.size <= CACHE_MAX) break;
    cache.delete(key);
  }
}

export function getAudio(id: string): Buffer | undefined {
  return cache.get(id);
}

export type { CharTiming };

export interface SynthResult {
  utteranceId: string;
  audioUrl: string;
  engine: string;
  timing?: CharTiming[];
  /** Total audio duration — lets callers scale playback timeouts to content. */
  durationMs: number;
}

/** Synth results keyed by exact text, so repeated phrases ("Working.",
    acknowledgments, re-read pages) skip synthesis entirely. Each playback
    still gets its own utteranceId; only the audio+timing are shared. */
const SYNTH_CACHE_MAX = 40;
const synthCache = new Map<string, { audio: Buffer; timing: CharTiming[]; engine: string }>();

function synthCachePut(text: string, entry: { audio: Buffer; timing: CharTiming[]; engine: string }) {
  synthCache.delete(text);
  synthCache.set(text, entry);
  for (const key of synthCache.keys()) {
    if (synthCache.size <= SYNTH_CACHE_MAX) break;
    synthCache.delete(key);
  }
}

/** LRU get — a hit refreshes recency so warm phrases survive page churn. */
function synthCacheGet(text: string) {
  const entry = synthCache.get(text);
  if (entry) {
    synthCache.delete(text);
    synthCache.set(text, entry);
  }
  return entry;
}

export function hasSynthCached(text: string): boolean {
  return synthCache.has(text);
}

/**
 * Split text at the first sentence boundary when both halves are substantial —
 * the head synthesizes in well under a second and plays while the tail
 * synthesizes concurrently. Returns null when splitting isn't worth it.
 */
export function splitFastStart(text: string): [string, string] | null {
  const m = /[.!?]+[")\]”’']*\s+/.exec(text);
  if (!m || m.index < 40 || text.length - (m.index + m[0].length) < 120) return null;
  return [text.slice(0, m.index + m[0].length), text.slice(m.index + m[0].length)];
}

function toResult(entry: { audio: Buffer; timing: CharTiming[]; engine: string }): SynthResult {
  const utteranceId = randomUUID();
  put(utteranceId, entry.audio);
  return {
    utteranceId,
    audioUrl: `/audio/${utteranceId}.wav`,
    engine: entry.engine,
    timing: entry.timing,
    durationMs: entry.timing.reduce((sum, t) => sum + t.duration_ms, 0),
  };
}

export async function synthesize(text: string): Promise<SynthResult | null> {
  const cached = synthCacheGet(text);
  if (cached) return toResult(cached);
  try {
    const res = await fetch(`${TTS_URL}/synth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;

    const data = await res.json() as { audio: string; timing: CharTiming[]; engine: string };
    const entry = { audio: Buffer.from(data.audio, "base64"), timing: data.timing, engine: data.engine };
    synthCachePut(text, entry);
    return toResult(entry);
  } catch {
    return null;
  }
}

/** Stock Computer phrases (see claude/CLAUDE.md's acknowledgment list) —
    pre-synthesized at boot so the instant-acknowledgment pattern is truly
    instant instead of paying first-use synthesis. */
const WARM_PHRASES = [
  "Working.",
  "Acknowledged.",
  "One moment.",
  "Reading.",
  "Accessing library computer records, one moment.",
  "Scanning ship's systems.",
  "Extrapolating, please wait.",
  "Unable to comply.",
];

/**
 * Fill the synth cache with the stock phrases once the sidecar is up.
 * Fire-and-forget from server boot; retries quietly because the sidecar is
 * optional and may start after the server (or never).
 */
export async function warmSynthCache(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await ttsHealth()) {
      for (const phrase of WARM_PHRASES) {
        if (!hasSynthCached(phrase)) await synthesize(phrase);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

export async function ttsHealth(): Promise<{ engine: string; voice: string } | null> {
  try {
    const res = await fetch(`${TTS_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as { engine: string; voice: string };
  } catch {
    return null;
  }
}
