import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type {
  ChimeRequest,
  ClearTimerRequest,
  DisplayHistoryRequest,
  DisplayHistoryResponse,
  DisplayRequest,
  RedisplayRequest,
  RedisplayResponse,
  MapControlAction,
  MapControlRequest,
  MediaRequest,
  SkyControlAction,
  SkyControlRequest,
  ReadArticleRequest,
  ReadArticleResponse,
  ScreenStateResponse,
  SetTimerRequest,
  SetTimerResponse,
  SpeakRequest,
  WorkingRequest,
} from "@tng/shared";
import { paginateArticle } from "@tng/shared";
import type { DisplayHub } from "../hub.js";
import { cancelActiveReading, startReading } from "../reading.js";
import { getArticle, parseArticleUrl } from "./article.js";
import { getAudio, hasSynthCached, splitFastStart, synthesize, synthesizeSegments, ttsHealth } from "../tts.js";
import { TimerEngine } from "../widgets.js";
import { PanelHistory, summarize } from "../history.js";
import { validateComposite } from "../composite.js";
import { loadSettings, saveSettings } from "../settings.js";
import { decorateYoutubeProps, getQueue, restorePlaylist } from "./youtube.js";

/** Below this length a speak is one utterance; splitting buys nothing. */
const CHUNK_MIN_CHARS = 180;

/** Bumped by anything that supersedes speech — a newer speak, a reading
    session, media stop. In-flight chunked playback loops check it before
    broadcasting their next chunk so a stale loop can't talk over new audio. */
let speechGeneration = 0;

/** What the viewer is currently reading: a text panel's body, or the visible
    article page. Empty for every other view. */
function onScreenText(hub: DisplayHub): string {
  const { view, props } = hub.state;
  if (view === "text" && typeof props.body === "string") return props.body;
  if (view === "image" && typeof props.body === "string") return props.body;
  if (view === "article" && Array.isArray(props.paragraphs)) {
    const pages = paginateArticle(props.paragraphs as string[]);
    const page = Math.min(Math.max(Number(props.page ?? 1), 1), pages.length);
    return pages[page - 1].join(" ");
  }
  return "";
}

/** "14:30" (24h, server-local) → epoch ms of the next occurrence. */
function parseAlarmTime(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const d = new Date();
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function humanTime(t: number): string {
  return new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function humanDelta(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `in ${s} seconds`;
  const m = Math.round(s / 60);
  if (m < 90) return `in ${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm
    ? `in ${h} hour${h === 1 ? "" : "s"} ${rm} minute${rm === 1 ? "" : "s"}`
    : `in ${h} hour${h === 1 ? "" : "s"}`;
}

/**
 * REST surface the console MCP server calls. Kept dumb: validate, forward to
 * the hub, answer. All intelligence lives in the Claude session.
 */
export function registerConsoleRoutes(app: FastifyInstance, hub: DisplayHub) {
  let lastCompositeAt = 0;
  // Unprompted server-initiated speech, used when a timer fires with the
  // session idle: chime, then speak, superseding any in-flight utterance —
  // an alarm outranks whatever the Computer happens to be saying or reading.
  const timerEngine = new TimerEngine(hub, async (text) => {
    cancelActiveReading();
    const gen = ++speechGeneration;
    hub.broadcast({ type: "chime", name: "complete" });
    const synth = await synthesize(text);
    if (gen !== speechGeneration) return; // something newer superseded the alarm
    if (synth) {
      hub.broadcast({
        type: "speak",
        utteranceId: synth.utteranceId,
        text,
        audioUrl: synth.audioUrl,
        caption: true,
        timing: synth.timing,
        // an alarm's job is noise — it sounds even when the voice is muted
        alarm: true,
      });
    } else {
      // TTS offline — caption-only, same degradation as the speak route.
      hub.broadcast({ type: "speak", utteranceId: randomUUID(), text, caption: true, alarm: true });
    }
  });
  const history = new PanelHistory();
  hub.setDisplayObserver((view, props) => history.record(view, props));

  // TNGC-27: the voice setting survives everything — load at boot, persist
  // on every change. hub.setVoice broadcasts voice_state to the wall(s).
  void loadSettings().then((s) => {
    if (s.voiceVolume !== undefined || s.voiceMuted !== undefined) {
      hub.setVoice(s.voiceVolume ?? 100, s.voiceMuted ?? false);
    }
  });

  app.post<{ Body: { action?: string; level?: number } }>("/api/console/voice", async (req, reply) => {
    const { action, level } = req.body ?? {};
    const actions = ["volume", "volume_up", "volume_down", "mute", "unmute"];
    if (!action || !actions.includes(action)) {
      return reply.code(400).send({ error: `action must be one of: ${actions.join(", ")}` });
    }
    const cur = hub.voice;
    let volume = cur.volume;
    let muted = cur.muted;
    if (action === "volume") {
      if (typeof level !== "number" || level < 0 || level > 100) {
        return reply.code(400).send({ error: "volume requires level between 0 and 100" });
      }
      volume = Math.round(level);
      muted = false; // setting a level implies wanting to hear it
    } else if (action === "volume_up") {
      volume = Math.min(100, volume + 15);
      muted = false;
    } else if (action === "volume_down") {
      // nudges floor at 10 — only explicit mute or level 0 silences
      volume = Math.max(10, volume - 15);
    } else if (action === "mute") {
      muted = true; // volume kept, so unmute restores the prior level
    } else if (action === "unmute") {
      muted = false;
    }
    hub.setVoice(volume, muted);
    saveSettings({ voiceVolume: volume, voiceMuted: muted });
    return { ok: true, volume, muted };
  });

  // Full (view, title, props) of what the wall shows RIGHT NOW — the library
  // save path (TNGC-23). Called by console-mcp, never the model: the props
  // (30 KB diagram SVGs, full article paragraphs) flow server → MCP → cloud
  // without touching model context. Navigation views have nothing to save.
  app.get("/api/console/history/current", async (_req, reply) => {
    const { view, props } = hub.state;
    if (view === "status" || view === "blank" || view === "boot") {
      return reply.code(409).send({ error: "nothing savable on screen (idle board)" });
    }
    return { ok: true, view, title: summarize(view, props), props };
  });

  app.post<{ Body: DisplayHistoryRequest }>("/api/console/display-history", async (req) => {
    const body: DisplayHistoryResponse = { ok: true, entries: history.list(req.body?.limit) };
    return body;
  });

  app.post<{ Body: RedisplayRequest }>("/api/console/redisplay", async (req, reply) => {
    const { id } = req.body ?? {};
    if (!id) return reply.code(400).send({ error: "id is required" });
    const entry = history.get(id);
    if (!entry) return reply.code(404).send({ error: `no history entry ${id}` });
    cancelActiveReading();
    const props =
      entry.view === "youtube"
        ? ((await decorateYoutubeProps(entry.props)) as typeof entry.props)
        : entry.props;
    hub.broadcast({ type: "display", view: entry.view, props });
    const body: RedisplayResponse = { ok: true, view: entry.view, summary: entry.summary };
    return body;
  });

  app.post<{ Body: DisplayRequest }>("/api/console/display", async (req, reply) => {
    const { view, props } = req.body ?? {};
    if (!view) return reply.code(400).send({ error: "view is required" });
    // A new panel supersedes an in-flight reading session.
    cancelActiveReading();
    // A saved playlist isn't a panel — it's queue state (TNGC-25). Restoring
    // here means the PWA's "Display on wall" (bridge POSTs to this route)
    // and the voice path both work with zero extra machinery.
    if ((view as string) === "playlist") {
      const result = restorePlaylist(props ?? {});
      if ("error" in result) return reply.code(409).send(result);
      return { view, ...result };
    }
    // Composite panels (TNGC-33) can be authored by PLUGINS, not just the
    // session — validate hard limits here, and rate-limit re-broadcasts so a
    // chatty plugin can't strobe the wall (in-place refreshes are legitimate;
    // strobing is not).
    if (view === "composite") {
      const err = validateComposite(props ?? {});
      if (err) return reply.code(400).send({ error: err });
      const now = Date.now();
      if (now - lastCompositeAt < 500) {
        return reply.code(429).send({ error: "composite refresh rate limit (2/s) — batch your updates" });
      }
      lastCompositeAt = now;
    }
    // Embed-blocked youtube videos flip to the extracted-audio path here —
    // server-decided, from cache (TNGC-24); the session never reasons about it.
    const resolved = view === "youtube" ? await decorateYoutubeProps(props ?? {}) : (props ?? {});
    hub.broadcast({ type: "display", view, props: resolved });
    return { ok: true, view };
  });

  app.post<{ Body: ReadArticleRequest }>("/api/console/read-article", async (req, reply) => {
    const { url, page } = req.body ?? {};
    if (!url) return reply.code(400).send({ error: "url is required" });
    let parsedUrl: URL;
    try {
      parsedUrl = parseArticleUrl(url);
    } catch {
      return reply.code(400).send({ error: "invalid url" });
    }
    let article;
    try {
      article = await getArticle(parsedUrl.href);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: `could not open page: ${message}` });
    }
    speechGeneration++; // reading supersedes any in-flight chunked speak
    const started = startReading(hub, parsedUrl.href, article, page ?? 1);
    const body: ReadArticleResponse = {
      ok: true,
      url: parsedUrl.href,
      title: article.title,
      page: started.page,
      pages: started.pages,
    };
    return body;
  });

  // Hit by Claude Code hooks (UserPromptSubmit / Stop), not the model: the
  // wall reacts the instant a prompt is submitted, before any thinking.
  app.post<{ Body: WorkingRequest }>("/api/console/working", async (req) => {
    const { active = true, chime = true } = req.body ?? {};
    hub.broadcast({ type: "working", active });
    if (active && chime) hub.broadcast({ type: "chime", name: "acknowledge" });
    return { ok: true, active };
  });

  // Hit by the bridge (not the model) on every command delivery and on the
  // session's turn-end hook: the wall's pending-commands badge mirrors how
  // many voice commands are waiting on the busy session (TNGC-21).
  app.post<{ Body: { count?: number } }>("/api/console/command-pending", async (req) => {
    const count = Math.max(0, Math.trunc(req.body?.count ?? 0));
    hub.setWidgets(
      "commands",
      count === 0 ? [] : [{ id: "commands", kind: "commands", count }],
    );
    return { ok: true, count };
  });

  const MAP_ACTIONS: MapControlAction[] = ["zoom_in", "zoom_out", "north", "south", "east", "west", "goto"];
  app.post<{ Body: MapControlRequest }>("/api/console/map-control", async (req, reply) => {
    const { action, amount, lat, lng, zoom, title } = req.body ?? {};
    if (!action || !MAP_ACTIONS.includes(action)) {
      return reply.code(400).send({ error: `action must be one of ${MAP_ACTIONS.join(", ")}` });
    }
    if (action === "goto" && (typeof lat !== "number" || typeof lng !== "number")) {
      return reply.code(400).send({ error: "goto requires numeric lat and lng" });
    }
    if (hub.state.view !== "map") {
      return reply.code(409).send({ error: "no map is on screen" });
    }
    hub.broadcast({ type: "map_control", action, amount, lat, lng, zoom, title });
    return { ok: true, action };
  });

  const SKY_ACTIONS: SkyControlAction[] = [
    "zoom_in", "zoom_out", "left", "right", "up", "down",
    "goto", "set_time", "advance_time", "timelapse", "track", "toggle",
  ];
  app.post<{ Body: SkyControlRequest }>("/api/console/sky-control", async (req, reply) => {
    const body = req.body ?? ({} as SkyControlRequest);
    const { action } = body;
    if (!action || !SKY_ACTIONS.includes(action)) {
      return reply.code(400).send({ error: `action must be one of ${SKY_ACTIONS.join(", ")}` });
    }
    if (action === "goto") {
      const hasTarget = typeof body.target === "string" && body.target.trim();
      const hasRaDec = typeof body.ra === "number" && typeof body.dec === "number";
      const hasAzAlt = typeof body.az === "number" || typeof body.alt === "number";
      if (!hasTarget && !hasRaDec && !hasAzAlt && typeof body.fov !== "number") {
        return reply.code(400).send({ error: "goto needs target, ra+dec, az/alt, or fov" });
      }
    }
    if (action === "set_time" && body.time !== undefined && !Number.isFinite(Date.parse(body.time))) {
      return reply.code(400).send({ error: "time must be an ISO timestamp (omit for now)" });
    }
    if (action === "advance_time" && !Number.isFinite(body.hours)) {
      return reply.code(400).send({ error: "advance_time needs numeric hours (negative = back)" });
    }
    if (action === "timelapse" && (typeof body.rate !== "number" || body.rate < 0)) {
      return reply.code(400).send({ error: "timelapse needs rate >= 0 (0 stops)" });
    }
    if (action === "toggle" && !["constellations", "labels", "planets"].includes(body.layer ?? "")) {
      return reply.code(400).send({ error: "toggle needs layer: constellations | labels | planets" });
    }
    if (hub.state.view !== "night-sky") {
      return reply.code(409).send({ error: "no night sky is on screen" });
    }
    hub.broadcast({ type: "sky_control", ...body });
    return { ok: true, action };
  });

  app.post<{ Body: SetTimerRequest }>("/api/console/timer", async (req, reply) => {
    const { kind, seconds, time, label, announce } = req.body ?? {};
    if (kind !== "timer" && kind !== "alarm") {
      return reply.code(400).send({ error: "kind must be timer or alarm" });
    }
    let endsAt: number;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
      endsAt = Date.now() + seconds * 1000;
    } else if (typeof time === "string") {
      const parsed = parseAlarmTime(time);
      if (parsed === null) {
        return reply.code(400).send({ error: "time must be HH:MM, 24-hour" });
      }
      endsAt = parsed;
    } else {
      return reply.code(400).send({ error: "give seconds (countdown) or time (HH:MM, 24-hour)" });
    }
    let widget;
    try {
      widget = timerEngine.set(kind, endsAt, label, announce);
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const body: SetTimerResponse = {
      ok: true,
      id: widget.id,
      endsAt,
      fires: humanTime(endsAt),
      in: humanDelta(endsAt - Date.now()),
    };
    return body;
  });

  app.post<{ Body: ClearTimerRequest }>("/api/console/timer-clear", async (req, reply) => {
    const { id } = req.body ?? {};
    const cleared = timerEngine.clear(id);
    if (id && cleared === 0) {
      return reply.code(404).send({ error: `no widget with id ${id}` });
    }
    return { ok: true, cleared };
  });

  app.post<{ Body: ChimeRequest }>("/api/console/chime", async (req, reply) => {
    const { name } = req.body ?? {};
    if (!name) return reply.code(400).send({ error: "name is required" });
    hub.broadcast({ type: "chime", name });
    return { ok: true, name };
  });

  app.post<{ Body: MediaRequest }>("/api/console/media", async (req, reply) => {
    const { action, rate, level } = req.body ?? {};
    const actions = [
      "pause", "play", "stop", "speed", "fullscreen", "windowed",
      "volume", "volume_up", "volume_down", "mute", "unmute",
    ];
    if (!actions.includes(action)) {
      return reply.code(400).send({ error: `action must be one of: ${actions.join(", ")}` });
    }
    if (action === "speed") {
      // YouTube's supported range; anything else the player silently ignores,
      // which would read as the command not working.
      if (typeof rate !== "number" || rate < 0.25 || rate > 2) {
        return reply.code(400).send({ error: "speed requires rate between 0.25 and 2" });
      }
      hub.broadcast({ type: "media", action, rate });
      return { ok: true, action, rate };
    }
    if (action === "volume") {
      if (typeof level !== "number" || level < 0 || level > 100) {
        return reply.code(400).send({ error: "volume requires level between 0 and 100" });
      }
      hub.broadcast({ type: "media", action, level: Math.round(level) });
      return { ok: true, action, level: Math.round(level) };
    }
    if (action === "stop") {
      cancelActiveReading();
      speechGeneration++;
      // TNGC-26: stop ends the playback SESSION (foreground or background) —
      // the persistent player tears down, the ♫ badge clears.
      hub.clearPlayback();
    }
    hub.broadcast({ type: "media", action });
    return { ok: true, action };
  });

  app.post<{ Body: SpeakRequest }>("/api/console/speak", async (req, reply) => {
    const { text: rawText, waitForPlayback = true, caption = true, lang = "en" } = req.body ?? {};
    // Mixed-language segments synthesize as ONE utterance; everywhere else
    // (caption, karaoke timing, screen-overlap probe) sees the joined text.
    const segments = req.body?.segments?.filter((s) => s.text);
    const text = segments?.length ? segments.map((s) => s.text).join("") : rawText;
    if (!text) return reply.code(400).send({ error: "text is required" });

    // The Computer speaking supersedes an in-flight reading session — never
    // talk over the reading voice.
    cancelActiveReading();
    const gen = ++speechGeneration;

    // If the spoken text is already on screen (model displayed it and then
    // spoke it without caption: false), a caption would draw the same words
    // over themselves. Detect the overlap, drop the caption, and aim the
    // karaoke caret at the on-screen copy instead.
    let effectiveCaption = caption;
    let screenOffset = 0;
    if (caption) {
      const probe = text.slice(0, 80);
      if (probe.length >= 40) {
        const at = onScreenText(hub).indexOf(probe);
        if (at >= 0) {
          effectiveCaption = false;
          screenOffset = at;
        }
      }
    }

    // Long uncached text streams as sentence-first chunks: the head
    // synthesizes in well under a second and plays while the tail
    // synthesizes concurrently — long answers start sounding immediately.
    const parts =
      !segments?.length && text.length >= CHUNK_MIN_CHARS && !hasSynthCached(text, lang)
        ? (splitFastStart(text) ?? [text])
        : [text];
    const synths = segments?.length
      ? [synthesizeSegments(segments)]
      : parts.map((p) => synthesize(p, lang));

    const first = await synths[0];
    if (!first) {
      // Sidecar down: caption-only single utterance so the Computer degrades
      // to silent-but-visible rather than mute-and-blank.
      const utteranceId = randomUUID();
      hub.broadcast({ type: "speak", utteranceId, text, caption: effectiveCaption });
      if (waitForPlayback) await hub.waitForSpeakDone(utteranceId);
      return { ok: true, utteranceId, tts: "offline" };
    }

    const playback = (async () => {
      let highlightBase = screenOffset;
      for (let i = 0; i < parts.length; i++) {
        const synth = i === 0 ? first : await synths[i];
        if (!synth || gen !== speechGeneration) return;
        hub.broadcast({
          type: "speak",
          utteranceId: synth.utteranceId,
          text: parts[i],
          audioUrl: synth.audioUrl,
          caption: effectiveCaption,
          timing: synth.timing,
          highlightBase,
        });
        await hub.waitForSpeakDone(synth.utteranceId, synth.durationMs + 20_000);
        highlightBase += parts[i].length;
      }
    })();
    if (waitForPlayback) await playback;
    return { ok: true, utteranceId: first.utteranceId, tts: first.engine };
  });

  app.get("/audio/:file", async (req, reply) => {
    const { file } = req.params as { file: string };
    const audio = getAudio(file.replace(/\.wav$/, ""));
    if (!audio) return reply.code(404).send({ error: "unknown utterance" });
    return reply.header("content-type", "audio/wav").send(audio);
  });

  // Article props carry the FULL paragraph list (the wall needs it), but
  // echoing all of it to the agent dumped ~12k tokens per screen_state call
  // on long articles. Summarize: swap paragraphs for page count + the
  // current page's text.
  app.get("/api/console/screen", async (): Promise<ScreenStateResponse> => {
    const s = hub.state;
    const extras = { voice: hub.voice, playback: hub.playbackState };
    if (s.view === "article" && Array.isArray(s.props.paragraphs)) {
      const pages = paginateArticle(s.props.paragraphs as string[]);
      const page = Math.min(Math.max(Number(s.props.page ?? 1), 1), pages.length);
      const { paragraphs: _full, ...rest } = s.props;
      return {
        view: s.view,
        props: { ...rest, page, pages: pages.length, pageText: pages[page - 1].join(" ") },
        connectedDisplays: s.connectedDisplays,
        widgets: s.widgets,
        queue: getQueue(),
        ...extras,
      };
    }
    return { ...s, queue: getQueue(), ...extras };
  });

  app.get("/api/console/tts", async () => (await ttsHealth()) ?? { engine: "offline" });
}
