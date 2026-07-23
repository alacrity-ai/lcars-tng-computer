/**
 * TenantHub — one Durable Object per tenant: the meeting point between
 * roaming phones (HTTP enqueue via the Worker) and the home bridge (a single
 * outbound WebSocket held from the office box).
 *
 * Queue semantics (the contract that matters):
 *  - every message is persisted to DO storage, then pushed down the socket
 *  - the bridge acks when the message is DISPATCHED to the session (or
 *    withdrawn) → delete; until then it sits in the bridge's visible
 *    dispatcher queue (TNGC-22)
 *  - unacked messages replay on (re)connect
 *  - at replay, messages older than the TTL are dropped and logged — voice
 *    is ephemeral; durability is for blips, not time-shifting speech
 *  - the bridge publishes its dispatcher snapshot (`queue` up-frames); the
 *    hub stores the latest and serves it to phones (/queue, counted on
 *    /status) — meaningless without a live link, so offline reads as empty
 *  - `withdraw` down-frames carry phone-side withdrawals/cancels to the
 *    bridge; permissions are enforced in the Worker before they get here
 */
import { DurableObject } from "cloudflare:workers";
import type {
  CloudDisplayCommand,
  CloudMessage,
  LinkDownFrame,
  LinkUpFrame,
  QueueItem,
  TngMessage,
} from "@tng/contract";

/** What lives under a `msg:` storage key: a transcript, or (TNGC-23) a
    library display command tagged with kind so replay re-frames it right.
    Sharing the prefix keeps ack/replay/depth one code path. */
type StoredCommand = CloudMessage | (CloudDisplayCommand & { kind: "display" });

function isDisplayCommand(c: StoredCommand): c is CloudDisplayCommand & { kind: "display" } {
  return "kind" in c && c.kind === "display";
}

export interface Env {
  DB: D1Database;
  TENANT_HUB: DurableObjectNamespace;
  /** Library payloads (TNGC-23) — props JSON, one object per saved item. */
  LIBRARY: R2Bucket;
  MESSAGE_TTL_MS?: string;
  /** Verification email plumbing (TNGC-29). Absent → mail is disabled and
      registration logs instead of sending (local dev). */
  MAILGUN_API_KEY?: string;
  MAILGUN_DOMAIN?: string;
  MAIL_FROM?: string;
  /** "1" echoes the verify URL in the register response — LOCAL HARNESSES ONLY. */
  DEV_ECHO_VERIFY?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class TenantHub extends DurableObject<Env> {
  private enqueueTimes: number[] = [];

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

  /** The bridge's dispatcher snapshot as last published (TNGC-22).
      Meaningless without a live link — report empty when offline rather
      than a stale queue. */
  private async queueItems(): Promise<QueueItem[]> {
    if (!this.online()) return [];
    return (await this.ctx.storage.get<QueueItem[]>("queue")) ?? [];
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
      // A fresh bridge starts with an empty queue; drop the old snapshot so
      // a crashed bridge's queue can't haunt the PWA until the first push.
      await this.ctx.storage.delete("queue");
      this.ctx.acceptWebSocket(pair[1]);
      await this.replay(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/enqueue" && req.method === "POST") {
      // Per-tenant flood fuse (TNGC-29): a DO is single-threaded per tenant,
      // so an in-memory sliding window is exact. Generous for a household —
      // it exists for runaway scripts, not people.
      const now = Date.now();
      this.enqueueTimes = this.enqueueTimes.filter((t) => now - t < 60_000);
      if (this.enqueueTimes.length >= 30) {
        return json({ error: "rate limit — slow down" }, 429);
      }
      this.enqueueTimes.push(now);
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
        pending: (await this.queueItems()).length,
      });
    }

    // Put a saved library item on the wall (TNGC-23). Metadata only — the
    // bridge fetches the payload at dispatch time. Same persistence/replay/
    // ack lifecycle as messages; permissions were enforced in the Worker.
    if (url.pathname === "/display-item" && req.method === "POST") {
      if (!this.online()) return json({ error: "Computer offline" }, 409);
      const cmd = (await req.json()) as CloudDisplayCommand;
      await this.ctx.storage.put(`msg:${cmd.id}`, { ...cmd, kind: "display" });
      const frame: LinkDownFrame = { v: 1, type: "display", cmd };
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(JSON.stringify(frame));
        } catch {
          // dead socket — the command stays stored; replay covers it
        }
      }
      return json({ ok: true, online: true, pending: (await this.queueItems()).length }, 202);
    }

    if (url.pathname === "/status") {
      return json({
        online: this.online(),
        queued: await this.depth(),
        pending: (await this.queueItems()).length,
      });
    }

    if (url.pathname === "/queue") {
      return json({ online: this.online(), items: await this.queueItems() });
    }

    if (url.pathname === "/withdraw" && req.method === "POST") {
      const { id, by } = (await req.json()) as { id?: string; by?: string };
      if (typeof id !== "string" || !id) return json({ error: "id is required" }, 400);
      if (!this.online()) return json({ error: "Computer offline — nothing to withdraw" }, 409);
      const frame: LinkDownFrame = { v: 1, type: "withdraw", id, by };
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(JSON.stringify(frame));
        } catch {
          // dead socket — the withdraw is lost, which the PWA's fast
          // re-poll makes visible (the item is still listed)
        }
      }
      return json({ ok: true }, 202);
    }

    return json({ error: "not found" }, 404);
  }

  /** Send every stored (= unacked) fresh command; drop and log the stale. */
  private async replay(ws: WebSocket): Promise<void> {
    const stored = await this.ctx.storage.list<StoredCommand>({ prefix: "msg:" });
    const cutoff = Date.now() - this.ttlMs;
    const ordered = [...stored.values()].sort((a, b) => a.ts - b.ts);
    for (const cmd of ordered) {
      if (cmd.ts < cutoff) {
        // Log identity + age only — never transcript content (multi-tenant
        // logs must not carry what people said in their homes, TNGC-29).
        console.log(
          `[hub] dropped stale command at replay (${Math.round((Date.now() - cmd.ts) / 1000)}s old) ` +
            `id=${cmd.id} from ${cmd.user}/${cmd.device}`,
        );
        await this.ctx.storage.delete(`msg:${cmd.id}`);
        continue;
      }
      const frame: LinkDownFrame = isDisplayCommand(cmd)
        ? { v: 1, type: "display", cmd: { ...cmd, kind: undefined } as CloudDisplayCommand }
        : { v: 1, type: "msg", msg: cmd };
      ws.send(JSON.stringify(frame));
    }
  }

  async webSocketMessage(_ws: WebSocket, data: ArrayBuffer | string): Promise<void> {
    if (typeof data !== "string") return;
    try {
      const frame = JSON.parse(data) as LinkUpFrame;
      if (frame.type === "ack" && typeof frame.id === "string") {
        await this.ctx.storage.delete(`msg:${frame.id}`);
      } else if (frame.type === "queue" && Array.isArray(frame.items)) {
        await this.ctx.storage.put("queue", frame.items.slice(0, 50));
      } else if (frame.type === "pending" && typeof frame.count === "number") {
        // Legacy count-only frame from a pre-TNGC-22 bridge: synthesize a
        // faceless snapshot so /status still counts something sensible.
        await this.ctx.storage.put(
          "queue",
          Array.from({ length: Math.min(50, Math.max(0, Math.trunc(frame.count))) }, (_, i) => ({
            id: `legacy_${i}`,
            user: "unknown",
            device: "unknown",
            transcript: "(pre-queue bridge — restart the session to see commands)",
            ts: Date.now(),
          })),
        );
      }
    } catch {
      // not a frame we know — ignore (forward compatibility)
    }
  }

  async webSocketClose(): Promise<void> {
    // Nothing to clean: getWebSockets() reflects reality, storage is the queue.
  }
}
