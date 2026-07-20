import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type {
  ChimeRequest,
  DisplayRequest,
  ScreenStateResponse,
  SpeakRequest,
} from "@tng/shared";
import type { DisplayHub } from "../hub.js";
import { getAudio, synthesize, ttsHealth } from "../tts.js";

/**
 * REST surface the console MCP server calls. Kept dumb: validate, forward to
 * the hub, answer. All intelligence lives in the Claude session.
 */
export function registerConsoleRoutes(app: FastifyInstance, hub: DisplayHub) {
  app.post<{ Body: DisplayRequest }>("/api/console/display", async (req, reply) => {
    const { view, props } = req.body ?? {};
    if (!view) return reply.code(400).send({ error: "view is required" });
    hub.broadcast({ type: "display", view, props: props ?? {} });
    return { ok: true, view };
  });

  app.post<{ Body: ChimeRequest }>("/api/console/chime", async (req, reply) => {
    const { name } = req.body ?? {};
    if (!name) return reply.code(400).send({ error: "name is required" });
    hub.broadcast({ type: "chime", name });
    return { ok: true, name };
  });

  app.post<{ Body: SpeakRequest }>("/api/console/speak", async (req, reply) => {
    const { text, waitForPlayback = true } = req.body ?? {};
    if (!text) return reply.code(400).send({ error: "text is required" });

    // Try real synthesis; if the sidecar is down, fall back to caption-only
    // so the Computer degrades to silent-but-visible rather than mute-and-blank.
    const synth = await synthesize(text);
    const utteranceId = synth?.utteranceId ?? randomUUID();
    hub.broadcast({ type: "speak", utteranceId, text, audioUrl: synth?.audioUrl });
    if (waitForPlayback) await hub.waitForSpeakDone(utteranceId);
    return { ok: true, utteranceId, tts: synth ? synth.engine : "offline" };
  });

  app.get("/audio/:file", async (req, reply) => {
    const { file } = req.params as { file: string };
    const audio = getAudio(file.replace(/\.wav$/, ""));
    if (!audio) return reply.code(404).send({ error: "unknown utterance" });
    return reply.header("content-type", "audio/wav").send(audio);
  });

  app.get("/api/console/screen", async (): Promise<ScreenStateResponse> => hub.state);

  app.get("/api/console/tts", async () => (await ttsHealth()) ?? { engine: "offline" });
}
