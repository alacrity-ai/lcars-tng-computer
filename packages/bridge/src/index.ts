#!/usr/bin/env node
/**
 * Bridge MCP server — channel delivery into the Computer session (TNGC-18)
 * + Tricorder cloud link (TNGC-14) + THE command queue (TNGC-22).
 *
 * Delivery model: the bridge declares the experimental `claude/channel`
 * capability and owns a dispatcher queue. While the session is idle, an
 * arriving command is pushed immediately as a channel notification; while a
 * turn is running (known from hooks — UserPromptSubmit posts /turn-start,
 * Stop posts /turn-end), commands are HELD HERE, visible and withdrawable,
 * and the next one dispatches on turn end. Holding the queue bridge-side —
 * instead of letting events pile up invisibly inside the harness — is what
 * makes "show me the queue", "withdraw that", and "cancel the running one"
 * possible at all. There is still no blocking tool and no re-arm discipline:
 * the v1 await-loop (TNGC-13) died at timeout boundaries, and every queue
 * transition here is hook- or message-driven.
 *
 * Cancellation: a channel event cannot interrupt a running turn (mid-turn
 * events deliver NEXT turn, by design), so cancel rides hooks instead: a
 * withdraw aimed at the ACTIVE command arms an abort flag; the session's
 * PreToolUse hook (claude/hooks/pretool-abort.sh) polls /abort-check and
 * denies every non-console tool with a CANCELLED notice until the turn ends.
 * An already-executing tool call runs out — the axe falls at the next one.
 *
 * Two producers feed the same queue:
 *  - local HTTP POST /message (office push-to-talk via scripts/say.sh)
 *  - an OUTBOUND WebSocket to the Tricorder Durable Object (phones anywhere).
 *    Outbound-only: nothing on the internet can reach into the house.
 *
 * Cloud contract (see @tng/contract): the hub persists every message and
 * replays unacked ones on reconnect; we ack at DISPATCH (or withdrawal), so
 * commands still queued here survive a bridge restart via replay + dedupe.
 * The TTL is an ARRIVAL check — once a command is visibly queued (and
 * withdrawable), waiting out a long turn is legitimate, not staleness.
 * Every queue change is published: count to the wall's badge, full snapshot
 * to the cloud (`queue` up-frame → the PWA's queue screen).
 *
 * Requires the session to be launched with:
 *   claude --dangerously-load-development-channels server:bridge
 * Without it, notifications are dropped SILENTLY (research-preview behavior)
 * — the peek_messages tool and /health exist to diagnose exactly that.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket from "ws";
import type { LinkDownFrame, LinkUpFrame, QueueItem, TngMessage } from "@tng/contract";
import { getItem } from "@tng/library-client";

const PORT = Number(process.env.TNG_BRIDGE_PORT ?? 3791);
/** Voice commands are ephemeral speech: anything older than this ON ARRIVAL
    (fresh post or cloud replay) is dropped, not executed. Deliberately-held
    queue time does NOT count — a visible queue makes waiting legitimate. */
const TTL_MS = Number(process.env.TNG_MESSAGE_TTL_MS ?? 60_000);
/** If a turn runs longer than this without a Stop, assume the hook was lost
    and fall back to immediate dispatch (harness-side queueing — the pre-22
    behavior). Degrades, never wedges. */
const BUSY_FAILSAFE_MS = Number(process.env.TNG_BUSY_FAILSAFE_MS ?? 10 * 60_000);
const CLOUD_URL = process.env.TNG_TRICORDER_URL;
const CLOUD_TOKEN = process.env.TNG_TRICORDER_TOKEN;
const SERVER_URL = process.env.TNG_SERVER_URL ?? "http://127.0.0.1:3789";

interface QueuedCommand extends TngMessage {
  /** Queue identity: the cloud id for phone commands, `loc_…` for local. */
  id: string;
  cloudId?: string;
  /** TNGC-23: a library display command — deterministic, no session turn.
      `transcript` carries the item title; the payload is fetched from the
      cloud only at dispatch time. */
  kind?: "transcript" | "display";
  itemId?: string;
}

// ---- MCP server (channel capability) ----------------------------------------

const server = new McpServer(
  { name: "tng-bridge", version: "0.6.0" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions:
      "Voice commands from household members arrive as channel events: " +
      '<channel source="bridge" user="..." device="...">transcript</channel>. ' +
      "They are one-way spoken requests — service each exactly like a spoken command per " +
      "CLAUDE.md (instant spoken acknowledgment, display-before-speak), addressing the " +
      'user named on the event and resolving "my"/"me" against that user. The bridge ' +
      "dispatches one command per turn; the rest wait in a visible queue. If a tool call " +
      "is denied with a CANCELLED notice, the person cancelled the current command from " +
      "their tricorder: abandon the task at once, speak one short acknowledgment " +
      "('Belayed.'), and end the turn.",
  },
);

// ---- queue state (TNGC-22) ----------------------------------------------------

let delivered = 0;
let deliveryFailures = 0;
// Commands ACCEPTED into the dispatcher (fresh, non-stale). `tng doctor`
// compares this with `delivered` to catch the silent-drop failure mode:
// accepted climbing while delivered stays 0 means commands reach this box
// but never reach the session (TNGC-31).
let accepted = 0;
/** deliveryFailures high-water mark at the last wall alert (one per streak). */
let deliveredAtLastAlert = 0;
const queue: QueuedCommand[] = [];
let active: QueuedCommand | null = null;
let abortRequest: { by: string; at: number } | null = null;
let busy = false;
let busySince = 0;

/** Ring buffer of recent messages for diagnostics (peek_messages / debugging
    silent channel drops). NOT the delivery path. */
const recent: Array<QueuedCommand & { deliveredAt: number; pushed: boolean }> = [];

function snapshot(): QueueItem[] {
  const pub = (c: QueuedCommand, isActive: boolean): QueueItem => ({
    id: c.id,
    user: c.user,
    device: c.device,
    transcript: c.transcript.length > 140 ? c.transcript.slice(0, 139) + "…" : c.transcript,
    ts: c.ts,
    ...(isActive ? { active: true } : {}),
    ...(isActive && abortRequest ? { cancelling: true } : {}),
    ...(c.kind === "display" ? { kind: "display" as const, itemId: c.itemId } : {}),
  });
  return [...(active ? [pub(active, true)] : []), ...queue.map((c) => pub(c, false))];
}

/** Publish every queue change: count → wall badge, snapshot → cloud/PWA. */
function pushState(): void {
  const items = snapshot();
  void fetch(`${SERVER_URL}/api/console/command-pending`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ count: items.length }),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => {
    // wall badge is best-effort; the count re-syncs on the next change
  });
  if (cloudSocket?.readyState === WebSocket.OPEN) {
    const frame: LinkUpFrame = { v: 1, type: "queue", items };
    try {
      cloudSocket.send(JSON.stringify(frame));
    } catch {
      // link recycling — the open handler re-syncs
    }
  }
}

function ackCloud(cloudId: string | undefined): void {
  if (!cloudId || cloudSocket?.readyState !== WebSocket.OPEN) return;
  const frame: LinkUpFrame = { v: 1, type: "ack", id: cloudId };
  try {
    cloudSocket.send(JSON.stringify(frame));
  } catch {
    // hub replays, dedupe eats it
  }
}

function enqueue(msg: TngMessage & { cloudId?: string; kind?: "transcript" | "display"; itemId?: string }): void {
  const age = Date.now() - msg.ts;
  if (age > TTL_MS) {
    console.error(
      `[bridge] dropped stale message on arrival (${Math.round(age / 1000)}s old): "${msg.transcript.slice(0, 60)}"`,
    );
    ackCloud(msg.cloudId); // stale: never execute, never replay
    return;
  }
  accepted++;
  queue.push({ ...msg, id: msg.cloudId ?? `loc_${randomUUID()}` });
  dispatch();
  pushState();
}

/** A library display command (TNGC-23): fetch the payload from the cloud and
    POST it straight to the console server — deterministic, no channel event,
    no session turn, no LLM tokens. Payload bytes flow cloud → here → wall
    server; never near model context. Failures are logged and acked (the
    user retries from the phone; a failed display must never replay). */
async function executeDisplay(cmd: QueuedCommand): Promise<void> {
  try {
    const { item, props } = await getItem(cmd.itemId!);
    const res = await fetch(`${SERVER_URL}/api/console/display`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: item.view, props }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`console server ${res.status}`);
    console.error(`[bridge] displayed library item "${cmd.transcript}" for ${cmd.user}`);
  } catch (err) {
    console.error(`[bridge] library display failed (${cmd.itemId}): ${(err as Error).message}`);
  } finally {
    ackCloud(cmd.cloudId);
    pushState();
  }
}

/** Push the next command into the session if it's idle. One TRANSCRIPT per
    turn; display commands at the head run immediately (they don't consume a
    turn or set busy) but still wait their turn behind a queued transcript —
    the queue is strictly ordered. */
function dispatch(): void {
  while (!busy && queue.length > 0 && queue[0].kind === "display") {
    void executeDisplay(queue.shift()!);
  }
  if (busy || queue.length === 0) return;
  const cmd = queue.shift()!;
  busy = true;
  busySince = Date.now();
  active = cmd;
  void (async () => {
    let pushed = false;
    try {
      await server.server.notification({
        method: "notifications/claude/channel",
        params: {
          content: cmd.transcript,
          // meta keys must be plain identifiers; values must be strings.
          meta: { user: cmd.user, device: cmd.device, ts: String(cmd.ts) },
        },
      });
      pushed = true;
      delivered++;
      ackCloud(cmd.cloudId);
    } catch (err) {
      deliveryFailures++;
      console.error(`[bridge] channel notification failed: ${(err as Error).message}`);
      // transport is broken, not busy — let the next event try again
      busy = false;
      active = null;
      // Never a silent hang (TNGC-31): after a streak of failures, say so ON
      // THE WALL — the classic cause is a Claude CLI that lost the
      // research-preview channels flag. One panel per streak.
      if (deliveryFailures - deliveredAtLastAlert >= 3) {
        deliveredAtLastAlert = deliveryFailures;
        void fetch(`${SERVER_URL}/api/console/display`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            view: "alert",
            props: {
              level: "yellow",
              title: "VOICE LINK FAULT",
              message: "Commands are reaching this Computer but cannot reach the session. Run: docker compose exec computer tng doctor",
            },
          }),
        }).catch(() => {});
      }
    }
    recent.push({ ...cmd, deliveredAt: Date.now(), pushed });
    while (recent.length > 20) recent.shift();
    pushState();
  })();
}

/** Withdraw a queued command, or arm cancellation of the active one. */
function withdraw(id: string, by: string): { ok: boolean; state?: string; error?: string } {
  const idx = queue.findIndex((c) => c.id === id);
  if (idx >= 0) {
    const [gone] = queue.splice(idx, 1);
    ackCloud(gone.cloudId); // never executed — but never replay it either
    console.error(`[bridge] "${gone.transcript.slice(0, 40)}" withdrawn by ${by}`);
    pushState();
    return { ok: true, state: "withdrawn" };
  }
  if (active?.id === id) {
    abortRequest = { by, at: Date.now() };
    console.error(`[bridge] active command cancel requested by ${by}`);
    pushState();
    return { ok: true, state: "cancelling" };
  }
  return { ok: false, error: "no such command (already finished?)" };
}

function onTurnStart(): void {
  // A typed developer prompt started a turn — hold the queue for its duration.
  busy = true;
  busySince = Date.now();
}

function onTurnEnd(): void {
  busy = false;
  active = null;
  abortRequest = null;
  dispatch();
  pushState();
}

// Failsafe: a lost Stop hook must degrade to pre-queue behavior, not wedge.
setInterval(() => {
  if (busy && Date.now() - busySince > BUSY_FAILSAFE_MS) {
    console.error(
      `[bridge] no turn-end for ${Math.round(BUSY_FAILSAFE_MS / 60000)}min — assuming the hook was lost, dispatching`,
    );
    onTurnEnd();
  }
}, 30_000).unref();

// Replay dedupe: ids already enqueued once (ack may have been lost).
const seenCloudIds = new Set<string>();
const seenOrder: string[] = [];
function firstSighting(id: string): boolean {
  if (seenCloudIds.has(id)) return false;
  seenCloudIds.add(id);
  seenOrder.push(id);
  while (seenOrder.length > 500) seenCloudIds.delete(seenOrder.shift()!);
  return true;
}

// ---- local endpoints (producer + hooks + queue control) -----------------------

const http = createServer((req, res) => {
  const respond = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (fn: (body: Record<string, unknown>) => void) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        fn(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        respond(400, { error: "invalid JSON body" });
      }
    });
  };

  if (req.method === "GET" && req.url === "/health") {
    return respond(200, {
      ok: true,
      mode: "channel-push",
      accepted,
      delivered,
      deliveryFailures,
      busy,
      active: active ? { id: active.id, user: active.user, cancelling: !!abortRequest } : null,
      queued: queue.length,
      ttlMs: TTL_MS,
      cloud: cloudState,
    });
  }
  if (req.method === "GET" && req.url === "/queue") {
    return respond(200, { items: snapshot() });
  }
  // Polled by the session's PreToolUse hook: when a cancel is armed, the hook
  // denies non-console tools until the turn ends.
  if (req.method === "GET" && req.url === "/abort-check") {
    return respond(200, { abort: !!abortRequest, by: abortRequest?.by ?? null });
  }
  // Hit by the session's UserPromptSubmit hook: a typed turn began.
  if (req.method === "POST" && req.url === "/turn-start") {
    onTurnStart();
    return respond(200, { ok: true });
  }
  // Hit by the session's Stop hook: the turn ended — dispatch the next command.
  if (req.method === "POST" && req.url === "/turn-end") {
    onTurnEnd();
    return respond(200, { ok: true });
  }
  if (req.method === "POST" && req.url === "/withdraw") {
    return readBody((body) => {
      if (typeof body.id !== "string") return respond(400, { error: "id is required" });
      const by = typeof body.by === "string" && body.by ? body.by : "local";
      const result = withdraw(body.id, by);
      respond(result.ok ? 202 : 404, result);
    });
  }
  if (req.method === "POST" && req.url === "/message") {
    return readBody((body) => {
      if (typeof body.transcript !== "string" || body.transcript.trim() === "") {
        return respond(400, { error: "transcript (non-empty string) is required" });
      }
      enqueue({
        user: typeof body.user === "string" && body.user ? body.user : "leif",
        device: typeof body.device === "string" && body.device ? body.device : "office",
        transcript: body.transcript.trim(),
        ts: Date.now(),
      });
      respond(202, { ok: true, mode: "channel-push", busy, queued: queue.length });
    });
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
      // Re-sync queue state after a link blip (frames sent while down are
      // lost — the snapshot, unlike messages, has no replay).
      pushState();
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
          enqueue({ ...msg, cloudId: id });
        } else if (frame.type === "withdraw" && typeof frame.id === "string") {
          withdraw(frame.id, typeof frame.by === "string" ? frame.by : "tricorder");
        } else if (frame.type === "display" && firstSighting(frame.cmd.id)) {
          const cmd = frame.cmd;
          enqueue({
            user: cmd.user,
            device: cmd.device,
            transcript: `Display: ${cmd.title}`,
            ts: cmd.ts,
            cloudId: cmd.id,
            kind: "display",
            itemId: cmd.itemId,
          });
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
      "Read-only diagnostics for the voice-command pipeline. Returns link state, the current " +
      "queue, and the last 20 messages the bridge received, with whether each was pushed as a " +
      "channel event. Use ONLY when debugging ('did my command reach the bridge?') — never to " +
      "receive commands; commands arrive on their own as channel events.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          cloud: cloudState,
          delivered,
          deliveryFailures,
          busy,
          queue: snapshot(),
          recent,
        }),
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
