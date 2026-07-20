import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type {
  ChimeRequest,
  DisplayRequest,
  ScreenStateResponse,
  SpeakRequest,
} from "@tng/shared";
import type { DisplayHub } from "../hub.js";

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

    const utteranceId = randomUUID();
    // Phase 2 wires audioUrl to the TTS service; until then the webapp
    // captions the utterance so the loop is testable end to end.
    hub.broadcast({ type: "speak", utteranceId, text });
    if (waitForPlayback) await hub.waitForSpeakDone(utteranceId);
    return { ok: true, utteranceId, tts: "offline" };
  });

  app.get("/api/console/screen", async (): Promise<ScreenStateResponse> => hub.state);
}
