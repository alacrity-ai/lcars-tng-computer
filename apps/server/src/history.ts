import { randomUUID } from "node:crypto";
import type { PanelHistoryEntry, PanelProps, PanelView } from "@tng/shared";

/** History depth; a wall session rarely reaches further back than this. */
const DEFAULT_CAPACITY = 50;

/** Navigation, not content — recording these would bury the real entries. */
const SKIP_VIEWS: PanelView[] = ["status", "blank", "boot"];

/** One-line human handle for an entry, from whichever prop names the content. */
function summarize(view: PanelView, props: PanelProps): string {
  const p = props as Record<string, unknown>;
  for (const key of ["title", "subject", "query", "location", "question", "caption"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
  }
  if (view === "youtube" && typeof p.videoId === "string") return `video ${p.videoId}`;
  if (typeof p.url === "string") return p.url;
  return view;
}

interface StoredEntry extends PanelHistoryEntry {
  props: PanelProps;
}

/**
 * Ring buffer of content panels the hub has broadcast, replayable by id.
 * Records through the hub's display observer, so every route that puts
 * content on the wall — display, open_url, show_profile, future panels —
 * is captured with zero per-route code. The session decides when a request
 * is a replay ("that diagram again") vs fresh work ("a new diagram"); this
 * class only remembers.
 */
export class PanelHistory {
  private entries: StoredEntry[] = [];

  constructor(
    private capacity = Number(process.env.TNG_HISTORY_SIZE ?? DEFAULT_CAPACITY),
  ) {}

  /** A re-broadcast of the screen just shown (quiz reveal, map redraw,
      article page turn) updates the last entry in place — one screen, one
      entry, latest props. */
  record(view: PanelView, props: PanelProps) {
    if (SKIP_VIEWS.includes(view)) return;
    const summary = summarize(view, props);
    const last = this.entries[this.entries.length - 1];
    if (last && last.view === view && last.summary === summary) {
      last.props = props;
      last.ts = Date.now();
      return;
    }
    this.entries.push({ id: randomUUID().slice(0, 8), ts: Date.now(), view, summary, props });
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  /** Newest first, summaries only — props never leave the server here. */
  list(limit = 20): PanelHistoryEntry[] {
    return this.entries
      .slice(-Math.max(1, limit))
      .reverse()
      .map(({ props: _props, ...entry }) => entry);
  }

  get(id: string): StoredEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }
}
