#!/usr/bin/env node
/**
 * Bridge MCP server — the Computer's event loop (TNGC-13) + Tricorder cloud
 * link (TNGC-14).
 *
 * MCP is pull-only: a server can't start a turn in the session. The bridge
 * inverts that with one blocking tool — when idle the Computer calls
 * `await_message`, which parks (zero tokens) until a transcript arrives, then
 * returns it and the session acts. Two producers feed the same local queue:
 *  - local HTTP POST /message (office push-to-talk via scripts/say.sh)
 *  - an OUTBOUND WebSocket to the Tricorder Durable Object (phones anywhere).
 *    Outbound-only: nothing on the internet can reach into the house.
 *
 * Cloud delivery contract (see @tng/contract): the hub persists every message
 * and replays unacked ones on reconnect; we ack only when a message is handed
 * to the session (returned by await_message). Replays are deduped by cloud id,
 * so the worst case is at-least-once, never lost-and-silent.
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
    fire when the loop re-arms after a stall). */
const TTL_MS = Number(process.env.TNG_MESSAGE_TTL_MS ?? 60_000);
const CLOUD_URL = process.env.TNG_TRICORDER_URL;
const CLOUD_TOKEN = process.env.TNG_TRICORDER_TOKEN;

interface QueuedMessage extends TngMessage {
  /** Present on cloud-delivered messages; acked at hand-to-session. */
  cloudId?: string;
}

type Waiter = { resolve: (m: QueuedMessage | null) => void; timer: NodeJS.Timeout };

class MessageQueue {
  private queue: QueuedMessage[] = [];
  private waiters: Waiter[] = [];
  /** Cloud ids already queued or already handed over — replay dedupe. */
  private seenCloudIds = new Set<string>();
  private seenOrder: string[] = [];
  /** Called with the cloud id when a message is handed to the session. */
  onDelivered: (cloudId: string) => void = () => {};

  get depth() {
    return this.queue.length;
  }
  get awaiting() {
    return this.waiters.length > 0;
  }

  private remember(id: string) {
    this.seenCloudIds.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > 500) this.seenCloudIds.delete(this.seenOrder.shift()!);
  }

  private dropStale() {
    const cutoff = Date.now() - TTL_MS;
    while (this.queue.length > 0 && this.queue[0].ts < cutoff) {
      const stale = this.queue.shift()!;
      console.error(
        `[bridge] dropped stale message (${Math.round((Date.now() - stale.ts) / 1000)}s old): ` +
          `"${stale.transcript.slice(0, 60)}"`,
      );
    }
  }

  private handOver(msg: QueuedMessage): TngMessage {
    if (msg.cloudId) this.onDelivered(msg.cloudId);
    const { cloudId: _cloudId, ...bare } = msg;
    return bare;
  }

  push(msg: QueuedMessage) {
    if (msg.cloudId) {
      if (this.seenCloudIds.has(msg.cloudId)) return; // replayed duplicate
      this.remember(msg.cloudId);
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
      return;
    }
    this.queue.push(msg);
  }

  take(timeoutMs: number): Promise<TngMessage | null> {
    this.dropStale();
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(this.handOver(queued));
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve: (m) => resolve(m ? this.handOver(m) : null),
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(null);
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

const queue = new MessageQueue();

// ---- local producer endpoint ------------------------------------------------

const http = createServer((req, res) => {
  const respond = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && req.url === "/health") {
    return respond(200, {
      ok: true,
      queued: queue.depth,
      awaiting: queue.awaiting,
      ttlMs: TTL_MS,
      cloud: cloudState,
    });
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
        queue.push({
          user: typeof body.user === "string" && body.user ? body.user : "leif",
          device: typeof body.device === "string" && body.device ? body.device : "office",
          transcript: body.transcript.trim(),
          ts: Date.now(),
        });
        return respond(202, { ok: true, queued: queue.depth, awaiting: queue.awaiting });
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
    // Almost always an orphaned bridge from a dead session still holding the
    // port (the known MCP-subprocess wart). Kill by port, never by pattern.
    console.error(
      `[bridge] port ${PORT} already in use — orphaned bridge? fix: fuser -k ${PORT}/tcp, then restart the session`,
    );
  } else {
    console.error(`[bridge] http error: ${err.message}`);
  }
  process.exit(1);
});
http.listen(PORT, "127.0.0.1", () => {
  console.error(`[bridge] queue endpoint on http://127.0.0.1:${PORT} (ttl ${TTL_MS}ms)`);
});

// ---- the outbound Tricorder link ---------------------------------------------

let cloudState: "disabled" | "connecting" | "up" | "down" = "disabled";
let cloudSocket: WebSocket | null = null;

queue.onDelivered = (cloudId) => {
  if (cloudSocket?.readyState === WebSocket.OPEN) {
    const frame: LinkUpFrame = { v: 1, type: "ack", id: cloudId };
    cloudSocket.send(JSON.stringify(frame));
  }
  // Socket down? Skip the ack — the hub will replay and dedupe eats it.
};

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
        if (frame.type === "msg") {
          const { id, ...msg } = frame.msg;
          queue.push({ ...msg, cloudId: id });
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

// ---- the blocking tool ------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const server = new McpServer({ name: "tng-bridge", version: "0.3.0" });

server.registerTool(
  "await_message",
  {
    description:
      "Block until the next queued request arrives (push-to-talk from tricorders or the " +
      "office). Returns {user, device, transcript, ts} — service it like any spoken request, " +
      'resolving "my"/"me" against that user — or {timeout: true}, meaning re-arm ' +
      "immediately and silently. Call this whenever you are idle; never end a turn without a " +
      "pending await. Messages older than 60s are dropped, not delivered.",
    inputSchema: {
      timeout_seconds: z
        .number()
        .min(1)
        .max(3600)
        .optional()
        .describe("How long to wait before returning {timeout: true}. Default 600."),
    },
  },
  async ({ timeout_seconds }) => {
    const msg = await queue.take((timeout_seconds ?? 600) * 1000);
    return textResult(JSON.stringify(msg ?? { timeout: true }));
  },
);

await server.connect(new StdioServerTransport());
console.error("[bridge] MCP server connected (stdio)");

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
