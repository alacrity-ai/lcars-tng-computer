import type { ChimeName } from "@tng/shared";

/** TNGC-27: the Computer's voice setting, synced from the server's
    voice_state broadcasts (module scope, videoFullscreen pattern — read at
    play time by the speak handler and the chimes). Distinct from media
    volume in every way: it's a persistent setting, and it never touches
    playback. */
export const voiceAudio = { volume: 100, muted: false };

// Earcon files live in public/sounds; anything missing falls back to acknowledge.
const SOUNDS: Record<ChimeName, string> = {
  acknowledge: "/sounds/acknowledge.mp3", // real TNG beep
  complete: "/sounds/complete.wav", // generated — see scripts/gen-earcons.mjs
  error: "/sounds/error.wav",
  "red-alert": "/sounds/red-alert.wav",
};

const FALLBACK = SOUNDS.acknowledge;

export async function playChime(name: ChimeName): Promise<void> {
  // Chimes ride the voice plane: they scale with voice volume and obey mute —
  // except red-alert, which is an alarm and always sounds at full volume.
  if (name !== "red-alert" && voiceAudio.muted) return;
  const volume = name === "red-alert" ? 1 : voiceAudio.volume / 100;
  const audio = new Audio(SOUNDS[name]);
  audio.volume = volume;
  try {
    await audio.play();
  } catch {
    if (SOUNDS[name] !== FALLBACK) {
      const fb = new Audio(FALLBACK);
      fb.volume = volume;
      await fb.play().catch(() => {});
    }
  }
}
