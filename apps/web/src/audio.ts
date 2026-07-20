import type { ChimeName } from "@tng/shared";

// Earcon files live in public/sounds; anything missing falls back to acknowledge.
const SOUNDS: Record<ChimeName, string> = {
  acknowledge: "/sounds/acknowledge.mp3", // real TNG beep
  complete: "/sounds/complete.wav", // generated — see scripts/gen-earcons.mjs
  error: "/sounds/error.wav",
  "red-alert": "/sounds/red-alert.wav",
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
