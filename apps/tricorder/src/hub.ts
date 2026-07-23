/**
 * TenantHub — one Durable Object per tenant: the meeting point between
 * roaming phones (HTTP enqueue via the Worker) and the home bridge (a single
 * outbound WebSocket held from the office box).
 *
 * Queue semantics (the contract that matters):
 *  - every message is persisted to DO storage, then pushed down the socket
 *  - the bridge acks when the message is handed to the session → delete
 *  - unacked messages replay on (re)connect
 *  - at replay, messages older than the TTL are dropped and logged — voice
 *    is ephemeral; durability is for blips, not time-shifting speech
 */
import { DurableObject } from "cloudflare:workers";
import type { CloudMessage, LinkDownFrame, LinkUpFrame, TngMessage } from "@tng/contract";

export interface Env {
  DB: D1Database;
  TENANT_HUB: DurableObjectNamespace;
  MESSAGE_TTL_MS?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class TenantHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive never wakes the hub: the platform answers "ping" with "pong".
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private get ttlMs(): number {
    return Number(this.env.MESSAGE_TTL_MS ?? 60_000);
  }

  private online(): boolean {
    return this.ctx.getWebSockets().length > 0;
  }

  private async depth(): Promise<number> {
    return (await this.ctx.storage.list({ prefix: "msg:" })).size;
  }

  /** Session-pending count as last reported by the bridge (TNGC-21).
      Meaningless without a live link — report 0 when the bridge is offline
      rather than a stale number. */
  private async pending(): Promise<number> {
    if (!this.online()) return 0;
    return (await this.ctx.storage.get<number>("pending")) ?? 0;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/link") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket upgrade required" }, 426);
      }
      const pair = new WebSocketPair();
      // Exactly one bridge per tenant: a new link replaces any stale ghost
      // (half-dead NAT sockets linger; the newest connection wins).
      for (const ws of this.ctx.getWebSockets()) ws.close(1012, "replaced by new link");
      this.ctx.acceptWebSocket(pair[1]);
      await this.replay(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/enqueue" && req.method === "POST") {
      const base = (await req.json()) as TngMessage;
      const msg: CloudMessage = { ...base, id: crypto.randomUUID() };
      await this.ctx.storage.put(`msg:${msg.id}`, msg);
      const frame: LinkDownFrame = { v: 1, type: "msg", msg };
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(JSON.stringify(frame));
        } catch {
          // dead socket — the message stays stored; replay covers it
        }
      }
      return json({
        ok: true,
        online: this.online(),
        queued: await this.depth(),
        pending: await this.pending(),
      });
    }

    if (url.pathname === "/status") {
      return json({
        online: this.online(),
        queued: await this.depth(),
        pending: await this.pending(),
      });
    }

    return json({ error: "not found" }, 404);
  }

  /** Send every stored (= unacked) fresh message; drop and log the stale. */
  private async replay(ws: WebSocket): Promise<void> {
    const stored = await this.ctx.storage.list<CloudMessage>({ prefix: "msg:" });
    const cutoff = Date.now() - this.ttlMs;
    const ordered = [...stored.values()].sort((a, b) => a.ts - b.ts);
    for (const msg of ordered) {
      if (msg.ts < cutoff) {
        console.log(
          `[hub] dropped stale message at replay (${Math.round((Date.now() - msg.ts) / 1000)}s old): ` +
            `"${msg.transcript.slice(0, 60)}" from ${msg.user}/${msg.device}`,
        );
        await this.ctx.storage.delete(`msg:${msg.id}`);
        continue;
      }
      const frame: LinkDownFrame = { v: 1, type: "msg", msg };
      ws.send(JSON.stringify(frame));
    }
  }

  async webSocketMessage(_ws: WebSocket, data: ArrayBuffer | string): Promise<void> {
    if (typeof data !== "string") return;
    try {
      const frame = JSON.parse(data) as LinkUpFrame;
      if (frame.type === "ack" && typeof frame.id === "string") {
        await this.ctx.storage.delete(`msg:${frame.id}`);
      } else if (frame.type === "pending" && typeof frame.count === "number") {
        await this.ctx.storage.put("pending", Math.max(0, Math.trunc(frame.count)));
      }
    } catch {
      // not a frame we know — ignore (forward compatibility)
    }
  }

  async webSocketClose(): Promise<void> {
    // Nothing to clean: getWebSockets() reflects reality, storage is the queue.
  }
}
