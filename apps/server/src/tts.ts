import { randomUUID } from "node:crypto";

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

export interface SynthResult {
  utteranceId: string;
  audioUrl: string;
  engine: string;
}

export async function synthesize(text: string): Promise<SynthResult | null> {
  try {
    const res = await fetch(`${TTS_URL}/synth`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const utteranceId = randomUUID();
    put(utteranceId, Buffer.from(await res.arrayBuffer()));
    return {
      utteranceId,
      audioUrl: `/audio/${utteranceId}.wav`,
      engine: res.headers.get("x-tng-engine") ?? "sidecar",
    };
  } catch {
    return null;
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
