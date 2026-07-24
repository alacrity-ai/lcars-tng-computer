import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
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

// Play queues — one per viewscreen (TNGC-35): music on wall A survives wall B
// changing panels, and each wall's queue advances independently. Module-level
// so the console screen_state route can report them. Server-owned for the
// same reason widgets are: the next video must start when the current one
// ends, and the Claude session is idle at that moment.
const queues = new Map<string, QueueItem[]>();

function queueFor(wall: string): QueueItem[] {
  let q = queues.get(wall);
  if (!q) {
    q = [];
    queues.set(wall, q);
  }
  return q;
}

export function getQueue(wall: string): QueueItem[] {
  return [...(queues.get(wall) ?? [])];
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
async function runYtdlp(args: string[], timeout = SEARCH_TIMEOUT_MS) {
  const opts = { timeout, maxBuffer: 8 * 1024 * 1024 };
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
    pre-check. Fail open on network trouble: a false positive just means the
    runtime fallback (TNGC-24 Layer 1) handles it instead. */
async function checkEmbeddable(videoId: string, timeoutMs = 5_000): Promise<boolean> {
  try {
    const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
      `https://www.youtube.com/watch?v=${videoId}`,
    )}&format=json`;
    const res = await fetch(url, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // 401/403 = embedding disabled or private; 400/404 = bad or deleted id.
    if ([400, 401, 403, 404].includes(res.status)) return false;
    return true;
  } catch {
    return true;
  }
}

// ---- embeddability cache (TNGC-24 Layer 0) -----------------------------------
// Verdicts are computed in parallel at search time anyway; remembering them
// lets every youtube broadcast decide embed-vs-audio with ZERO extra latency
// and no visible failure. Runtime embed errors also feed it (Layer 1), so a
// video oEmbed lied about stays audio for the TTL.
const EMBED_TTL_MS = 6 * 60 * 60_000;
const EMBED_CACHE_MAX = 500;
const embedCache = new Map<string, { ok: boolean; at: number }>();

function rememberEmbeddable(videoId: string, ok: boolean) {
  embedCache.delete(videoId); // re-insert = move to the fresh end (Map is ordered)
  embedCache.set(videoId, { ok, at: Date.now() });
  while (embedCache.size > EMBED_CACHE_MAX) {
    embedCache.delete(embedCache.keys().next().value!);
  }
}

/** Cached verdict, or a single live oEmbed check (short timeout, fail-open —
    a wrong "embeddable" just lands on the reactive fallback). */
async function isEmbeddable(videoId: string): Promise<boolean> {
  const hit = embedCache.get(videoId);
  if (hit && Date.now() - hit.at < EMBED_TTL_MS) return hit.ok;
  const ok = await checkEmbeddable(videoId, 1_500);
  rememberEmbeddable(videoId, ok);
  return ok;
}

// ---- audio stream resolution (TNGC-24) ----------------------------------------
// yt-dlp -g resolves a direct googlevideo audio URL. Memoized per videoId so
// prewarm (fired at broadcast time) and the proxy route share one resolution;
// entries expire on the URL's own `expire` param. Never redirect clients to
// these URLs — they are bound to the resolving IP; the proxy makes that moot.
// Opt-out switch for distributed builds (TNGC-30): audio extraction is a
// HOUSE-side feature — appliance composes ship TNG_AUDIO_FALLBACK=0 and users
// opt in. Absent (our dev stack) = enabled, unchanged.
const AUDIO_FALLBACK_ENABLED = process.env.TNG_AUDIO_FALLBACK !== "0";

const AUDIO_RESOLVE_TIMEOUT_MS = 30_000;
const AUDIO_URL_FALLBACK_TTL_MS = 4 * 60 * 60_000;
const audioUrls = new Map<string, { promise: Promise<string>; expiresAt: number }>();

function resolveAudioUrl(videoId: string): Promise<string> {
  const hit = audioUrls.get(videoId);
  if (hit && Date.now() < hit.expiresAt) return hit.promise;
  const entry = { expiresAt: Date.now() + AUDIO_URL_FALLBACK_TTL_MS } as {
    promise: Promise<string>;
    expiresAt: number;
  };
  entry.promise = (async () => {
    // player_client=android: the web client refuses tokenless extraction
    // ("This video is not available") and most clients now withhold
    // audio-only adaptive streams, so the selector chain ends in `best` —
    // a muxed mp4 whose audio track the wall's <audio> element plays fine
    // (the wasted video bytes are noise at household scale). Verified
    // 2026-07-23; if YouTube churns again, this one flag is the knob.
    const { stdout } = await runYtdlp(
      [
        "--no-warnings",
        "--extractor-args", "youtube:player_client=android",
        "-f", "bestaudio[ext=m4a]/bestaudio/best[acodec!=none]/best",
        "-g", `https://www.youtube.com/watch?v=${videoId}`,
      ],
      AUDIO_RESOLVE_TIMEOUT_MS,
    );
    const url = stdout.trim().split("\n")[0];
    if (!url.startsWith("http")) throw new Error("yt-dlp returned no stream URL");
    // googlevideo URLs carry their own expiry (epoch seconds); honor it
    // with a safety margin so we never hand the <audio> element a corpse.
    const expire = Number(new URL(url).searchParams.get("expire"));
    entry.expiresAt = Number.isFinite(expire) && expire > 0
      ? expire * 1000 - 10 * 60_000
      : Date.now() + AUDIO_URL_FALLBACK_TTL_MS;
    return url;
  })();
  entry.promise.catch(() => audioUrls.delete(videoId)); // failed resolutions don't stick
  audioUrls.set(videoId, entry);
  return entry.promise;
}

/** Fire-and-forget resolution at broadcast time, so the <audio> element's
    first request finds the URL already resolved (~1–3s hidden). */
function prewarmAudio(videoId: string) {
  resolveAudioUrl(videoId).catch(() => {
    // the proxy route will retry and surface a real error if it persists
  });
}

/** Decide embed vs audio for ANY youtube broadcast — display route, queue
    advance, error substitution. This is the whole of TNGC-24 Layer 0: no
    MCP traffic, no model reasoning, at most one ~200ms oEmbed check on a
    cache miss. Exported for the console display route. */
export async function decorateYoutubeProps(
  props: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!AUDIO_FALLBACK_ENABLED) return props;
  const videoId = props.videoId;
  if (typeof videoId !== "string" || props.audioOnly === true) {
    if (typeof videoId === "string" && props.audioOnly === true) prewarmAudio(videoId);
    return props;
  }
  if (await isEmbeddable(videoId)) return props;
  prewarmAudio(videoId);
  return { ...props, audioOnly: true };
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

/** One track of a saved playlist (TNGC-25) — metadata only; playability is
    re-decided at restore time by the TNGC-24 decoration. */
interface PlaylistTrack {
  videoId: string;
  title?: string;
  channel?: string;
  durationSeconds?: number;
}

function asTracks(value: unknown): PlaylistTrack[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .filter((t) => typeof t.videoId === "string" && /^[A-Za-z0-9_-]{11}$/.test(t.videoId as string))
    .map((t) => ({
      videoId: t.videoId as string,
      title: typeof t.title === "string" ? t.title : undefined,
      channel: typeof t.channel === "string" ? t.channel : undefined,
      durationSeconds: typeof t.durationSeconds === "number" ? t.durationSeconds : undefined,
    }));
}

/** Restore a saved playlist (TNGC-25): REPLACE the play queue with tracks
    2..N and start track 1 through the embed-vs-audio decoration. Assigned a
    real implementation inside registerYoutubeRoutes (it needs the hub
    closures); the console display route calls it for view === "playlist",
    which is what makes the PWA's "Display on wall" and the voice path
    restore identically with no bridge involvement. */
export let restorePlaylist: (props: Record<string, unknown>, wall: string) =>
  | { ok: true; started: PlaylistTrack; queued: number }
  | { error: string } = () => ({ error: "youtube routes not registered yet" });

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
      // Annotate embeddability (parallel, ~200ms) but DROP NOTHING and keep
      // YouTube's relevance order: an embed-blocked official track is still
      // the right answer — it just plays as extracted audio (TNGC-24).
      const checks = await Promise.all(found.map((r) => checkEmbeddable(r.videoId)));
      const results = found.map((r, i) => {
        rememberEmbeddable(r.videoId, checks[i]);
        return { ...r, embeddable: checks[i] };
      });
      lastResults = results;
      failedIds.clear();
      const body: YoutubeSearchResponse = { ok: true, query: query.trim(), results };
      return body;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `youtube search failed: ${message}` });
    }
  });

  /** Sync a wall's up-next badge to its queue. Call after every mutation —
      the badge exists iff something is waiting. */
  function pushQueueWidget(wall: string) {
    const q = queueFor(wall);
    hub.setWidgets(
      "queue",
      q.length === 0
        ? []
        : [
            {
              id: "queue",
              kind: "queue",
              count: q.length,
              nextTitle: q[0].title ?? q[0].videoId,
            },
          ],
      wall,
    );
  }

  /** Broadcast a youtube panel through the embed-vs-audio decision (Layer 0).
      Async only for a cache-miss oEmbed check; callers fire-and-forget. */
  async function broadcastYoutube(props: Record<string, unknown>, wall: string): Promise<void> {
    hub.broadcast({ type: "display", view: "youtube", props: await decorateYoutubeProps(props) }, wall);
  }

  /** Start a track wherever the playback session lives (TNGC-26): a display
      broadcast when the player has the screen, a `playback track` message
      when it's backgrounded — so a queue advance under a diagram never
      steals the panel. Decoration (TNGC-24) applies on both paths. */
  async function playTrack(props: Record<string, unknown>, wall: string): Promise<void> {
    const decorated = await decorateYoutubeProps(props);
    if (hub.playbackBackgrounded(wall)) hub.playbackTrack(decorated, wall);
    else hub.broadcast({ type: "display", view: "youtube", props: decorated }, wall);
  }

  /** Pop the head of a wall's queue into its playback session. Returns what
      started, if anything. */
  function playNext(wall: string): QueueItem | undefined {
    const next = queueFor(wall).shift();
    if (!next) return undefined;
    void playTrack({
      videoId: next.videoId,
      title: next.title,
      channel: next.channel,
      autoplay: true,
    }, wall);
    pushQueueWidget(wall);
    return next;
  }

  app.post<{ Body: QueueRequest }>("/api/console/queue", async (req, reply) => {
    const { action, videoId, title, channel, durationSeconds } = req.body ?? {};
    const wall = hub.resolveWall(req.body?.wall);
    const queue = queueFor(wall);
    if (action === "add") {
      if (!videoId) return reply.code(400).send({ error: "add requires videoId" });
      if (queue.length >= MAX_QUEUE) {
        return reply.code(409).send({ error: `queue is full (${MAX_QUEUE})` });
      }
      queue.push({ videoId, title, channel, durationSeconds });
      // Nothing playing ON THIS WALL to wait for → start it immediately
      // rather than stranding the queue. A backgrounded track counts as
      // playing (TNGC-26) — adding while music runs under a diagram queues.
      if (hub.stateFor(wall).view !== "youtube" && !hub.playbackState(wall)) {
        const started = playNext(wall);
        const body: QueueResponse = { ok: true, queue: getQueue(wall), nowPlaying: started };
        return body;
      }
      pushQueueWidget(wall);
      const body: QueueResponse = { ok: true, queue: getQueue(wall) };
      return body;
    }
    if (action === "skip") {
      const started = playNext(wall);
      if (!started) return reply.code(409).send({ error: "queue is empty — nothing to skip to" });
      const body: QueueResponse = { ok: true, queue: getQueue(wall), nowPlaying: started };
      return body;
    }
    if (action === "clear") {
      queues.set(wall, []);
      pushQueueWidget(wall);
      const body: QueueResponse = { ok: true, queue: [] };
      return body;
    }
    if (action === "list") {
      const body: QueueResponse = { ok: true, queue: getQueue(wall) };
      return body;
    }
    return reply.code(400).send({ error: "action must be add, skip, clear, or list" });
  });

  // The playlist snapshot (TNGC-25): now playing + everything queued, in
  // order — what "save this playlist" captures. Read by console-mcp so the
  // track list flows server → MCP → cloud without touching model context.
  app.get<{ Querystring: { wall?: string } }>("/api/console/playlist/current", async (req, reply) => {
    const wall = hub.resolveWall(req.query?.wall);
    const s = hub.stateFor(wall);
    const now: PlaylistTrack[] =
      s.view === "youtube" && typeof s.props.videoId === "string"
        ? [
            {
              videoId: s.props.videoId,
              title: typeof s.props.title === "string" ? s.props.title : undefined,
              channel: typeof s.props.channel === "string" ? s.props.channel : undefined,
            },
          ]
        : [];
    const tracks = [...now, ...queueFor(wall)];
    if (tracks.length === 0) {
      return reply.code(409).send({ error: "nothing is playing and nothing is queued" });
    }
    return { ok: true, tracks, count: tracks.length };
  });

  restorePlaylist = (props, wall) => {
    const tracks = asTracks(props.tracks);
    if (tracks.length === 0) return { error: "playlist has no playable tracks" };
    const [first, ...rest] = tracks;
    // REPLACE the queue: playing a playlist means starting that vibe, not
    // appending to whatever was pending.
    queues.set(wall, rest.slice(0, MAX_QUEUE));
    if (rest.length > MAX_QUEUE) {
      console.warn(`[youtube] playlist restore truncated ${rest.length - MAX_QUEUE} tracks (queue cap ${MAX_QUEUE})`);
    }
    void broadcastYoutube({
      videoId: first.videoId,
      title: first.title,
      channel: first.channel,
      autoplay: true,
    }, wall);
    pushQueueWidget(wall);
    return { ok: true, started: first, queued: queueFor(wall).length };
  };

  // The audio stream proxy (TNGC-24): the wall's <audio> element plays
  // /api/console/audio/<id>. Proxy, never redirect — googlevideo URLs are
  // bound to the resolving IP, and proxying keeps retries/fixes server-only.
  // Range passthrough is what makes seeking (startSeconds) work.
  app.get<{ Params: { videoId: string } }>("/api/console/audio/:videoId", async (req, reply) => {
    if (!AUDIO_FALLBACK_ENABLED) {
      return reply.code(404).send({ error: "audio fallback disabled (TNG_AUDIO_FALLBACK=0)" });
    }
    const { videoId } = req.params;
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return reply.code(400).send({ error: "bad video id" });
    }
    const range = req.headers.range;
    const upstream = async (fresh: boolean) => {
      if (fresh) audioUrls.delete(videoId);
      const url = await resolveAudioUrl(videoId);
      // No abort signal: this response BODY streams for the whole track —
      // a timeout here would cut the music off mid-song.
      return fetch(url, { headers: { "user-agent": UA, ...(range ? { range } : {}) } });
    };
    try {
      let up = await upstream(false);
      if (up.status === 403 || up.status === 410) {
        // cached URL expired early — re-resolve once
        up.body?.cancel().catch(() => {});
        up = await upstream(true);
      }
      if (up.status !== 200 && up.status !== 206) {
        up.body?.cancel().catch(() => {});
        return reply.code(502).send({ error: `audio upstream ${up.status}` });
      }
      reply.code(up.status);
      for (const h of ["content-type", "content-length", "content-range"] as const) {
        const v = up.headers.get(h);
        if (v) reply.header(h, v);
      }
      reply.header("accept-ranges", up.headers.get("accept-ranges") ?? "bytes");
      return reply.send(up.body ? Readable.fromWeb(up.body as NodeWebReadableStream) : Buffer.alloc(0));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `audio resolution failed: ${message}` });
    }
  });

  // Natural end of a video → seamless advance to the next queued one, on the
  // wall that reported it. Guarded against stale reports via that wall's
  // PLAYBACK record, not the visible panel (TNGC-26): with music backgrounded
  // under a diagram, the old state.view guard silently dropped the event and
  // stranded the queue.
  hub.setVideoEndedHandler((wall, videoId) => {
    if (hub.playbackVideoId(wall) !== videoId) return;
    if (!playNext(wall) && hub.playbackBackgrounded(wall)) {
      // Nothing next and nobody watching — end the session so the ♫ badge
      // doesn't advertise a dead track. Foregrounded keeps today's behavior
      // (the ended player stays on screen).
      hub.clearPlayback(wall);
    }
  });

  // Backstop for failures oEmbed can't see (region locks, age restriction).
  // TNGC-24 layered order — the person asked for THIS track, so:
  //   embed error → Layer 1: retry the SAME video as extracted audio;
  //   audio error → Layer 2: next search candidate (decorated — a blocked
  //   candidate plays as audio) → queue → yellow alert.
  hub.setVideoErrorHandler((wall, videoId, _code, audio) => {
    void (async () => {
      // Guard on the reporting wall's playback record (TNGC-26/35).
      if (hub.playbackVideoId(wall) !== videoId) return;
      if (!audio) rememberEmbeddable(videoId, false);
      if (!audio && AUDIO_FALLBACK_ENABLED) {
        // The iframe failed but the media almost certainly exists — flip to
        // the audio path and remember the verdict so the next play of this
        // video skips the embed entirely. playTrack keeps a backgrounded
        // flip invisible. With the fallback disabled (distributed builds,
        // TNGC-30) an embed error falls straight to substitution below.
        await playTrack({ ...(hub.playbackProps(wall) ?? { videoId }), audioOnly: true, autoplay: true }, wall);
        return;
      }
      // The AUDIO path failed — this video is genuinely unplayable.
      failedIds.add(videoId);
      for (const cand of lastResults) {
        if (failedIds.has(cand.videoId)) continue;
        await playTrack({ videoId: cand.videoId, title: cand.title, channel: cand.channel, autoplay: true }, wall);
        return;
      }
      // No search-result substitute — fall through to the queue before
      // giving up (the errored video may itself have been queued).
      if (playNext(wall)) return;
      hub.clearPlayback(wall);
      // Only take the screen for the failure if the player HAD the screen —
      // backgrounded music dying must not yank the visible panel.
      if (hub.stateFor(wall).view === "youtube") {
        hub.broadcast({
          type: "display",
          view: "alert",
          props: {
            level: "yellow",
            title: "Video unavailable",
            message: "No playable version found — try a different search",
          },
        }, wall);
      }
    })();
  });
}
