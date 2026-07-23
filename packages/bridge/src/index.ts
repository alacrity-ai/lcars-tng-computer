#!/usr/bin/env node
/**
 * Bridge MCP server — channel delivery into the Computer session (TNGC-18)
 * + Tricorder cloud link (TNGC-14).
 *
 * Delivery model: the bridge declares the experimental `claude/channel`
 * capability and PUSHES each message into the running session as a channel
 * notification the moment it arrives — idle sessions start a turn
 * immediately, busy sessions receive queued events as a group on the next
 * turn (Claude Code owns that queueing). There is no blocking tool and no
 * re-arm discipline: the v1 await-loop (TNGC-13) died at timeout boundaries,
 * where every {timeout:true} return was a fresh model-discipline decision.
 *
 * Two producers feed the same delivery path:
 *  - local HTTP POST /message (office push-to-talk via scripts/say.sh)
 *  - an OUTBOUND WebSocket to the Tricorder Durable Object (phones anywhere).
 *    Outbound-only: nothing on the internet can reach into the house.
 *
 * Cloud contract (see @tng/contract): the hub persists every message and
 * replays unacked ones on reconnect; we ack once the channel notification is
 * written to the session transport. Replays are deduped by cloud id.
 *
 * Requires the session to be launched with:
 *   claude --dangerously-load-development-channels server:bridge
 * Without it, notifications are dropped SILENTLY (research-preview behavior)
 * — the peek_messages tool and /health exist to diagnose exactly that.
 */
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket from "ws";
import type { LinkDownFrame, LinkUpFrame, TngMessage } from "@tng/contract";

const PORT = Number(process.env.TNG_BRIDGE_PORT ?? 3791);
/** Voice commands are ephemeral speech: anything older than this at delivery
    time is dropped, not executed ("play jazz" from 20 minutes ago must never
    fire after a stall). Applies to cloud replays; local posts are born fresh. */
const TTL_MS = Number(process.env.TNG_MESSAGE_TTL_MS ?? 60_000);
const CLOUD_URL = process.env.TNG_TRICORDER_URL;
const CLOUD_TOKEN = process.env.TNG_TRICORDER_TOKEN;

interface InboundMessage extends TngMessage {
  /** Present on cloud-delivered messages; acked once pushed to the session. */
  cloudId?: string;
}

// ---- MCP server (channel capability) ----------------------------------------

const server = new McpServer(
  { name: "tng-bridge", version: "0.4.0" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions:
      "Voice commands from household members arrive as channel events: " +
      '<channel source="bridge" user="..." device="...">transcript</channel>. ' +
      "They are one-way spoken requests — service each exactly like a spoken command per " +
      "CLAUDE.md (instant spoken acknowledgment, display-before-speak), addressing the " +
      'user named on the event and resolving "my"/"me" against that user. Multiple events ' +
      "in one turn arrive oldest-first; service them in order.",
  },
);

let delivered = 0;
let deliveryFailures = 0;

// ---- pending-commands badge (TNGC-21) ----------------------------------------
// Counts commands pushed into the session since its last turn ended: while the
// session is mid-turn, new commands queue in the harness and this is their
// count; the Stop hook POSTs /turn-end and the badge clears as the queued
// group is absorbed into the next turn. A command delivered while idle shows
// briefly as 1 — "command in flight" — until its turn's own Stop.
// Two sinks, both fire-and-forget: the console server (wall badge widget) and
// the Tricorder cloud (a "pending" up-frame, surfaced to phones via /status).
const SERVER_URL = process.env.TNG_SERVER_URL ?? "http://127.0.0.1:3789";
let pendingCommands = 0;

function pushPending(count: number): void {
  pendingCommands = count;
  void fetch(`${SERVER_URL}/api/console/command-pending`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ count }),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => {
    // wall badge is best-effort; the count re-syncs on the next change
  });
  if (cloudSocket?.readyState === WebSocket.OPEN) {
    const frame: LinkUpFrame = { v: 1, type: "pending", count };
    try {
      cloudSocket.send(JSON.stringify(frame));
    } catch {
      // link recycling — the next change re-syncs
    }
  }
}
/** Ring buffer of recent messages for diagnostics (peek_messages / debugging
    silent channel drops). NOT the delivery path. */
const recent: Array<InboundMessage & { deliveredAt: number; pushed: boolean }> = [];

async function deliver(msg: InboundMessage): Promise<void> {
  const age = Date.now() - msg.ts;
  if (age > TTL_MS) {
    console.error(
      `[bridge] dropped stale message (${Math.round(age / 1000)}s old): "${msg.transcript.slice(0, 60)}"`,
    );
    return;
  }
  let pushed = false;
  try {
    await server.server.notification({
      method: "notifications/claude/channel",
      params: {
        content: msg.transcript,
        // meta keys must be plain identifiers; values must be strings.
        meta: { user: msg.user, device: msg.device, ts: String(msg.ts) },
      },
    });
    pushed = true;
    delivered++;
    pushPending(pendingCommands + 1);
    if (msg.cloudId && cloudSocket?.readyState === WebSocket.OPEN) {
      const frame: LinkUpFrame = { v: 1, type: "ack", id: msg.cloudId };
      cloudSocket.send(JSON.stringify(frame));
    }
    // Ack skipped when the socket is down: the hub replays, dedupe eats it.
  } catch (err) {
    deliveryFailures++;
    console.error(`[bridge] channel notification failed: ${(err as Error).message}`);
  }
  recent.push({ ...msg, deliveredAt: Date.now(), pushed });
  while (recent.length > 20) recent.shift();
}

// Replay dedupe: ids already pushed to the session (ack may have been lost).
const seenCloudIds = new Set<string>();
const seenOrder: string[] = [];
function firstSighting(id: string): boolean {
  if (seenCloudIds.has(id)) return false;
  seenCloudIds.add(id);
  seenOrder.push(id);
  while (seenOrder.length > 500) seenCloudIds.delete(seenOrder.shift()!);
  return true;
}

// ---- local producer endpoint ------------------------------------------------

const http = createServer((req, res) => {
  const respond = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && req.url === "/health") {
    return respond(200, {
      ok: true,
      mode: "channel-push",
      delivered,
      deliveryFailures,
      pendingCommands,
      ttlMs: TTL_MS,
      cloud: cloudState,
    });
  }
  // Hit by the session's Stop hook: the turn ended, so every command counted
  // so far is serviced (or being absorbed into the next turn right now).
  if (req.method === "POST" && req.url === "/turn-end") {
    if (pendingCommands !== 0) pushPending(0);
    return respond(200, { ok: true });
  }
  if (req.method === "POST" && req.url === "/message") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const body = JSON.parse(raw) as Partial<TngMessage>;
        if (typeof body.transcript !== "string" || body.transcript.trim() === "") {
          return respond(400, { error: "transcript (non-empty string) is required" });
        }
        void deliver({
          user: typeof body.user === "string" && body.user ? body.user : "leif",
          device: typeof body.device === "string" && body.device ? body.device : "office",
          transcript: body.transcript.trim(),
          ts: Date.now(),
        });
        return respond(202, { ok: true, mode: "channel-push" });
      } catch {
        return respond(400, { error: "invalid JSON body" });
      }
    });
    return;
  }
  respond(404, { error: "not found" });
});

http.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[bridge] port ${PORT} already in use — orphaned bridge? fix: fuser -k ${PORT}/tcp, then restart the session`,
    );
  } else {
    console.error(`[bridge] http error: ${err.message}`);
  }
  process.exit(1);
});
// Loopback by default; the Computer container sets TNG_BRIDGE_HOST=0.0.0.0 so
// Docker can publish the port back to the host's 127.0.0.1 (say.sh). Never
// bind 0.0.0.0 on a bare host — this endpoint is unauthenticated by design.
const HOST = process.env.TNG_BRIDGE_HOST ?? "127.0.0.1";
http.listen(PORT, HOST, () => {
  console.error(`[bridge] queue endpoint on http://${HOST}:${PORT} (channel push, ttl ${TTL_MS}ms)`);
});

// ---- the outbound Tricorder link ---------------------------------------------

let cloudState: "disabled" | "connecting" | "up" | "down" = "disabled";
let cloudSocket: WebSocket | null = null;

function startCloudLink() {
  if (!CLOUD_URL || !CLOUD_TOKEN) {
    console.error(
      "[bridge] no tricorder link configured (TNG_TRICORDER_URL / TNG_TRICORDER_TOKEN unset) — local-only mode",
    );
    return;
  }
  let attempt = 0;

  const connect = () => {
    cloudState = "connecting";
    const ws = new WebSocket(CLOUD_URL, {
      headers: { authorization: `Bearer ${CLOUD_TOKEN}` },
      handshakeTimeout: 10_000,
    });
    cloudSocket = ws;
    let lastActivity = Date.now();
    let keepalive: NodeJS.Timeout | null = null;
    let retried = false;

    const retry = () => {
      if (retried) return;
      retried = true;
      cloudState = "down";
      cloudSocket = null;
      if (keepalive) clearInterval(keepalive);
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 6));
      console.error(`[bridge] tricorder link down — retrying in ${Math.round(delay / 1000)}s`);
      setTimeout(connect, delay);
    };

    ws.on("open", () => {
      attempt = 0;
      cloudState = "up";
      lastActivity = Date.now();
      console.error("[bridge] tricorder link up");
      // Re-sync the pending badge after a link blip (frames sent while down
      // are lost — the count, unlike messages, has no replay).
      const frame: LinkUpFrame = { v: 1, type: "pending", count: pendingCommands };
      ws.send(JSON.stringify(frame));
      // App-level keepalive: the DO answers "ping" with "pong" without waking.
      keepalive = setInterval(() => {
        if (Date.now() - lastActivity > 90_000) {
          console.error("[bridge] tricorder link silent >90s — recycling");
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, 30_000);
    });

    ws.on("message", (data) => {
      lastActivity = Date.now();
      const text = data.toString();
      if (text === "pong") return;
      try {
        const frame = JSON.parse(text) as LinkDownFrame;
        if (frame.type === "msg" && firstSighting(frame.msg.id)) {
          const { id, ...msg } = frame.msg;
          void deliver({ ...msg, cloudId: id });
        }
      } catch {
        // unknown frame — ignore (forward compatibility)
      }
    });

    ws.on("close", retry);
    ws.on("error", (err) => {
      console.error(`[bridge] tricorder link error: ${err.message}`);
      retry();
    });
  };

  connect();
}

startCloudLink();

// ---- read-only diagnostics tool ----------------------------------------------

server.registerTool(
  "peek_messages",
  {
    description:
      "Read-only diagnostics for the voice-command pipeline. Returns link state and the last " +
      "20 messages the bridge received, with whether each was pushed as a channel event. Use " +
      "ONLY when debugging ('did my command reach the bridge?') — never to receive commands; " +
      "commands arrive on their own as channel events.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ cloud: cloudState, delivered, deliveryFailures, recent }),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
console.error("[bridge] MCP server connected (stdio, channel capability declared)");

// Exit when the stdio pipe dies (session gone). Without this, a killed parent
// pnpm orphans the tsx child, which keeps holding the port AND the cloud
// socket — the wall looks "online" with no brain attached (claude-code#36730
// class of wart; also why `make down` kills by port, not pattern).
const shutdown = () => {
  console.error("[bridge] stdin closed — shutting down");
  process.exit(0);
};
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
