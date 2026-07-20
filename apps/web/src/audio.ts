import type { ChimeName } from "@tng/shared";

// Earcon files live in public/sounds. Only acknowledge exists so far;
// the rest fall back to it until Phase 2 adds the full set.
const SOUNDS: Record<ChimeName, string> = {
  acknowledge: "/sounds/acknowledge.mp3",
  complete: "/sounds/complete.mp3",
  error: "/sounds/error.mp3",
  "red-alert": "/sounds/red-alert.mp3",
};

const FALLBACK = SOUNDS.acknowledge;

export async function playChime(name: ChimeName): Promise<void> {
  const audio = new Audio(SOUNDS[name]);
  try {
    await audio.play();
  } catch {
    if (SOUNDS[name] !== FALLBACK) {
      await new Audio(FALLBACK).play().catch(() => {});
    }
  }
}
