import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import type {
  QueueItem,
  QueueRequest,
  QueueResponse,
  YoutubeSearchRequest,
  YoutubeSearchResponse,
  YoutubeSearchResult,
} from "@tng/shared";
import type { DisplayHub } from "../hub.js";

const MAX_QUEUE = 25;

// Play queue — module-level so the console screen_state route can report it.
// Server-owned for the same reason widgets are: the next video must start
// when the current one ends, and the Claude session is idle at that moment.
let queue: QueueItem[] = [];

export function getQueue(): QueueItem[] {
  return [...queue];
}

const execFileAsync = promisify(execFile);

const SEARCH_TIMEOUT_MS = 25_000;
const UA = "tng-computer/0.1 (home LCARS wall)";

// The stack image ships without yt-dlp. Rather than requiring an image
// rebuild (the fence: docker/ is host-owned), the server self-provisions:
// on ENOENT it downloads the standalone zipapp once into apps/server/.cache
// (gitignored) and uses that. The zipapp's shebang wants python3, which the
// stack image has; egress from the stack container is unrestricted.
const YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";
const YTDLP_CACHE = path.join(import.meta.dirname, "..", "..", ".cache", "yt-dlp");

let ytdlpPath = process.env.TNG_YTDLP_PATH ?? "yt-dlp";
let ytdlpDownload: Promise<string> | null = null;

/** Resolve a runnable yt-dlp, downloading the standalone zipapp on first
    need. Memoized so concurrent searches share one download; reset on
    failure so a transient network error doesn't wedge the route. */
function ensureYtdlp(): Promise<string> {
  ytdlpDownload ??= (async () => {
    try {
      await access(YTDLP_CACHE, constants.X_OK);
      return YTDLP_CACHE;
    } catch {
      // not cached yet — download below
    }
    const res = await fetch(YTDLP_URL, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`yt-dlp download failed: HTTP ${res.status}`);
    await mkdir(path.dirname(YTDLP_CACHE), { recursive: true });
    const tmp = `${YTDLP_CACHE}.tmp`;
    await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
    await chmod(tmp, 0o755);
    await rename(tmp, YTDLP_CACHE);
    return YTDLP_CACHE;
  })();
  ytdlpDownload.catch(() => {
    ytdlpDownload = null;
  });
  return ytdlpDownload;
}

/** execFile yt-dlp, self-provisioning the binary when it's absent. An
    explicit TNG_YTDLP_PATH is authoritative — never overridden by a
    download. */
async function runYtdlp(args: string[]) {
  const opts = { timeout: SEARCH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 };
  try {
    return await execFileAsync(ytdlpPath, args, opts);
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!missing || process.env.TNG_YTDLP_PATH) throw err;
    ytdlpPath = await ensureYtdlp();
    return await execFileAsync(ytdlpPath, args, opts);
  }
}

/** Embed-disabled videos 401 on YouTube's oEmbed endpoint — a cheap keyless
    pre-check that keeps "Playback on other websites has been disabled" off
    the wall. Fail open on network trouble: a false positive just means the
    runtime auto-advance handles it instead. */
async function isEmbeddable(videoId: string): Promise<boolean> {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`,
    )}&format=json`;
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(5_000),
    });
    // 401/403 = embedding disabled or private; 400/404 = bad or deleted id.
    if ([400, 401, 403, 404].includes(res.status)) return false;
    return true;
  } catch {
    return true;
  }
}

/** Native YouTube search via yt-dlp's ytsearch extractor — surfaces
    small-channel uploads that general web search indexes never rank.
    Flat-playlist mode returns metadata only; nothing is downloaded. */
export async function searchYoutube(
  query: string,
  limit: number,
): Promise<YoutubeSearchResult[]> {
  const { stdout } = await runYtdlp([
    `ytsearch${limit}:${query}`,
    "--flat-playlist",
    "--dump-single-json",
    "--no-warnings",
  ]);
  const parsed = JSON.parse(stdout) as { entries?: Array<Record<string, unknown>> };
  return (parsed.entries ?? [])
    .filter((e) => typeof e.id === "string" && typeof e.title === "string")
    .map((e) => ({
      videoId: e.id as string,
      title: e.title as string,
      channel: (e.channel ?? e.uploader) as string | undefined,
      durationSeconds: typeof e.duration === "number" ? Math.round(e.duration) : undefined,
      viewCount: typeof e.view_count === "number" ? e.view_count : undefined,
      url: (e.url as string | undefined) ?? `https://www.youtube.com/watch?v=${e.id as string}`,
    }));
}

export function registerYoutubeRoutes(app: FastifyInstance, hub: DisplayHub) {
  // Candidates from the most recent search, in rank order — the pool the
  // runtime auto-advance draws from when a played video errors on the wall.
  let lastResults: YoutubeSearchResult[] = [];
  const failedIds = new Set<string>();

  app.post<{ Body: YoutubeSearchRequest }>("/api/console/youtube-search", async (req, reply) => {
    const { query, limit } = req.body ?? {};
    if (!query?.trim()) return reply.code(400).send({ error: "query is required" });
    const capped = Math.min(Math.max(Math.trunc(limit ?? 6), 1), 10);
    try {
      const found = await searchYoutube(query.trim(), capped);
      // Drop embed-disabled videos up front (checked in parallel, ~200ms).
      const checks = await Promise.all(found.map((r) => isEmbeddable(r.videoId)));
      const results = found.filter((_, i) => checks[i]);
      lastResults = results;
      failedIds.clear();
      const body: YoutubeSearchResponse = { ok: true, query: query.trim(), results };
      return body;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `youtube search failed: ${message}` });
    }
  });

  /** Sync the wall's up-next badge to the queue. Call after every mutation —
      the badge exists iff something is waiting. */
  function pushQueueWidget() {
    hub.setWidgets(
      "queue",
      queue.length === 0
        ? []
        : [
            {
              id: "queue",
              kind: "queue",
              count: queue.length,
              nextTitle: queue[0].title ?? queue[0].videoId,
            },
          ],
    );
  }

  /** Pop the head of the queue onto the wall. Returns what started, if anything. */
  function playNext(): QueueItem | undefined {
    const next = queue.shift();
    if (!next) return undefined;
    hub.broadcast({
      type: "display",
      view: "youtube",
      props: { videoId: next.videoId, title: next.title, autoplay: true },
    });
    pushQueueWidget();
    return next;
  }

  app.post<{ Body: QueueRequest }>("/api/console/queue", async (req, reply) => {
    const { action, videoId, title, channel, durationSeconds } = req.body ?? {};
    if (action === "add") {
      if (!videoId) return reply.code(400).send({ error: "add requires videoId" });
      if (queue.length >= MAX_QUEUE) {
        return reply.code(409).send({ error: `queue is full (${MAX_QUEUE})` });
      }
      queue.push({ videoId, title, channel, durationSeconds });
      // Nothing playing to wait for → start it immediately rather than
      // stranding the queue until some future video ends.
      if (hub.state.view !== "youtube") {
        const started = playNext();
        const body: QueueResponse = { ok: true, queue: getQueue(), nowPlaying: started };
        return body;
      }
      pushQueueWidget();
      const body: QueueResponse = { ok: true, queue: getQueue() };
      return body;
    }
    if (action === "skip") {
      const started = playNext();
      if (!started) return reply.code(409).send({ error: "queue is empty — nothing to skip to" });
      const body: QueueResponse = { ok: true, queue: getQueue(), nowPlaying: started };
      return body;
    }
    if (action === "clear") {
      queue = [];
      pushQueueWidget();
      const body: QueueResponse = { ok: true, queue: [] };
      return body;
    }
    if (action === "list") {
      const body: QueueResponse = { ok: true, queue: getQueue() };
      return body;
    }
    return reply.code(400).send({ error: "action must be add, skip, clear, or list" });
  });

  // Natural end of a video → seamless advance to the next queued one. Guarded
  // against stale reports: only advance if the ended video is still the one
  // on screen (a panel change or manual "play X" makes old ENDED events moot).
  hub.setVideoEndedHandler((videoId) => {
    const s = hub.state;
    if (s.view !== "youtube" || s.props.videoId !== videoId) return;
    playNext();
  });

  // Backstop for failures oEmbed can't see (region locks, age restriction):
  // when the wall's player errors on the video we're showing, silently play
  // the next candidate from the last search.
  hub.setVideoErrorHandler((videoId) => {
    void (async () => {
      failedIds.add(videoId);
      const s = hub.state;
      if (s.view !== "youtube" || s.props.videoId !== videoId) return;
      for (const cand of lastResults) {
        if (failedIds.has(cand.videoId)) continue;
        if (!(await isEmbeddable(cand.videoId))) {
          failedIds.add(cand.videoId);
          continue;
        }
        hub.broadcast({
          type: "display",
          view: "youtube",
          props: { videoId: cand.videoId, title: cand.title, autoplay: true },
        });
        return;
      }
      // No viable search-result substitute — fall through to the queue
      // before giving up (the errored video may itself have been queued).
      if (playNext()) return;
      hub.broadcast({
        type: "display",
        view: "alert",
        props: {
          level: "yellow",
          title: "Video unavailable",
          message: "No playable version found — try a different search",
        },
      });
    })();
  });
}
