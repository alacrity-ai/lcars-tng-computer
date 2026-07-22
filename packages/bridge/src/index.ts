#!/usr/bin/env node
/**
 * Bridge MCP server — the Computer's event loop (TNGC-13).
 *
 * MCP is pull-only: a server can't start a turn in the session. The bridge
 * inverts that with one blocking tool — when idle the Computer calls
 * `await_message`, which parks (zero tokens) until a transcript arrives on the
 * local HTTP endpoint, then returns it and the session acts. Producers today:
 * office push-to-talk (scripts/say.sh). Phase 3 (TNGC-14) adds the outbound
 * WebSocket from the Tricorder cloud queue as a second producer; only this
 * package changes.
 */
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PORT = Number(process.env.TNG_BRIDGE_PORT ?? 3791);
/** Voice commands are ephemeral speech: anything older than this at delivery
    time is dropped, not executed ("play jazz" from 20 minutes ago must never
    fire when the loop re-arms after a stall). */
const TTL_MS = Number(process.env.TNG_MESSAGE_TTL_MS ?? 60_000);

export interface TngMessage {
  user: string;
  device: string;
  transcript: string;
  ts: number;
}

type Waiter = { resolve: (msg: TngMessage | null) => void; timer: NodeJS.Timeout };

class MessageQueue {
  private queue: TngMessage[] = [];
  private waiters: Waiter[] = [];

  get depth() {
    return this.queue.length;
  }
  get awaiting() {
    return this.waiters.length > 0;
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

  push(msg: TngMessage) {
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
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
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
    return respond(200, { ok: true, queued: queue.depth, awaiting: queue.awaiting, ttlMs: TTL_MS });
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

// ---- the blocking tool ------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const server = new McpServer({ name: "tng-bridge", version: "0.2.0" });

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
