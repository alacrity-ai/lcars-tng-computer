import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type {
  ChimeRequest,
  ClearTimerRequest,
  DisplayRequest,
  MapControlAction,
  MapControlRequest,
  MediaRequest,
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
import { getAudio, hasSynthCached, splitFastStart, synthesize, ttsHealth } from "../tts.js";
import { TimerEngine } from "../widgets.js";
import { getQueue } from "./youtube.js";

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
      });
    } else {
      // TTS offline — caption-only, same degradation as the speak route.
      hub.broadcast({ type: "speak", utteranceId: randomUUID(), text, caption: true });
    }
  });
  app.post<{ Body: DisplayRequest }>("/api/console/display", async (req, reply) => {
    const { view, props } = req.body ?? {};
    if (!view) return reply.code(400).send({ error: "view is required" });
    // A new panel supersedes an in-flight reading session.
    cancelActiveReading();
    hub.broadcast({ type: "display", view, props: props ?? {} });
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
    const { action, rate } = req.body ?? {};
    if (action !== "pause" && action !== "play" && action !== "stop" && action !== "speed") {
      return reply.code(400).send({ error: "action must be pause, play, stop, or speed" });
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
    if (action === "stop") {
      cancelActiveReading();
      speechGeneration++;
    }
    hub.broadcast({ type: "media", action });
    return { ok: true, action };
  });

  app.post<{ Body: SpeakRequest }>("/api/console/speak", async (req, reply) => {
    const { text, waitForPlayback = true, caption = true } = req.body ?? {};
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
      text.length >= CHUNK_MIN_CHARS && !hasSynthCached(text)
        ? (splitFastStart(text) ?? [text])
        : [text];
    const synths = parts.map((p) => synthesize(p));

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
      };
    }
    return { ...s, queue: getQueue() };
  });

  app.get("/api/console/tts", async () => (await ttsHealth()) ?? { engine: "offline" });
}
