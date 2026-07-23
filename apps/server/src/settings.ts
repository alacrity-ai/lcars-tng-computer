/**
 * Tiny persistent settings store (TNGC-27) — for values that are SETTINGS,
 * not session state: they must survive wall reloads, session restarts, and
 * stack restarts. Lives in the gitignored .cache next to yt-dlp. Writes are
 * fire-and-forget (a lost write costs one re-utterance of "lower your
 * voice", never correctness).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FILE = path.join(import.meta.dirname, "..", ".cache", "settings.json");

export interface PersistedSettings {
  voiceVolume?: number;
  voiceMuted?: boolean;
}

export async function loadSettings(): Promise<PersistedSettings> {
  try {
    return JSON.parse(await readFile(FILE, "utf8")) as PersistedSettings;
  } catch {
    return {};
  }
}

let pending: PersistedSettings = {};
let writing = false;

export function saveSettings(patch: PersistedSettings): void {
  pending = { ...pending, ...patch };
  if (writing) return; // the in-flight write's follow-up pass picks it up
  writing = true;
  void (async () => {
    while (Object.keys(pending).length > 0) {
      const current = { ...(await loadSettings()), ...pending };
      pending = {};
      try {
        await mkdir(path.dirname(FILE), { recursive: true });
        await writeFile(FILE, JSON.stringify(current, null, 2));
      } catch (err) {
        console.warn(`[settings] write failed: ${(err as Error).message}`);
        break;
      }
    }
    writing = false;
  })();
}
