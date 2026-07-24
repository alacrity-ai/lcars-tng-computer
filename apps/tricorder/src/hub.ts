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
  RosterDisplay,
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

  /** Bridge link sockets. Tagged "link" since TNGC-35/36; sockets with NO
      tags are pre-tag bridges that survived a deploy under hibernation —
      treat them as links so an upgrade never orphans a live house. */
  private linkSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const tags = this.ctx.getTags(ws);
      return tags.includes("link") || tags.length === 0;
    });
  }

  /** Phone sockets in Viewscreen mode (TNGC-36), optionally one user's. */
  private screenSockets(user?: string): WebSocket[] {
    return this.ctx.getWebSockets(user ? `user:${user}` : "screen");
  }

  private online(): boolean {
    return this.linkSockets().length > 0;
  }

  private sendDown(frame: LinkDownFrame): void {
    for (const ws of this.linkSockets()) {
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        // dead socket — persistent frames replay; ephemeral ones re-derive
      }
    }
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
      for (const ws of this.linkSockets()) ws.close(1012, "replaced by new link");
      // A fresh bridge starts with an empty queue and no roster; drop the old
      // snapshots so a crashed bridge's state can't haunt the PWA.
      await this.ctx.storage.delete("queue");
      await this.ctx.storage.delete("roster");
      this.ctx.acceptWebSocket(pair[1], ["link"]);
      await this.replay(pair[1]);
      // Re-attach every phone still in Viewscreen mode (TNGC-36): the new
      // bridge knows nothing about them, and frames only flow while it does.
      const users = new Set<string>();
      for (const ws of this.screenSockets()) {
        const tag = this.ctx.getTags(ws).find((t) => t.startsWith("user:"));
        if (tag) users.add(tag.slice(5));
      }
      for (const user of users) {
        try {
          pair[1].send(JSON.stringify({ v: 1, type: "display_open", name: `tricorder-${user}` } satisfies LinkDownFrame));
        } catch {
          // link died mid-handshake — its replacement will redo this
        }
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // Viewscreen mode (TNGC-36): a phone attaches here to RECEIVE display
    // frames. The Worker authenticated the session and passes the user
    // handle; the first socket for a user opens the house-side display,
    // the last one closing shuts it.
    if (url.pathname === "/screen") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket upgrade required" }, 426);
      }
      const user = req.headers.get("x-user-handle") ?? "";
      if (!user) return json({ error: "missing user" }, 400);
      const pair = new WebSocketPair();
      const already = this.screenSockets(user).length > 0;
      this.ctx.acceptWebSocket(pair[1], ["screen", `user:${user}`]);
      if (!already) {
        this.sendDown({ v: 1, type: "display_open", name: `tricorder-${user}` });
      }
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
      this.sendDown({ v: 1, type: "msg", msg });
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
      this.sendDown({ v: 1, type: "display", cmd });
      return json({ ok: true, online: true, pending: (await this.queueItems()).length }, 202);
    }

    if (url.pathname === "/status") {
      return json({
        online: this.online(),
        queued: await this.depth(),
        pending: (await this.queueItems()).length,
        // TNGC-35: the house's live viewscreens (bridge-reported). Offline →
        // empty, like the queue — a stale roster is worse than none.
        displays: this.online()
          ? ((await this.ctx.storage.get<RosterDisplay[]>("roster")) ?? [])
          : [],
      });
    }

    if (url.pathname === "/queue") {
      return json({ online: this.online(), items: await this.queueItems() });
    }

    if (url.pathname === "/withdraw" && req.method === "POST") {
      const { id, by } = (await req.json()) as { id?: string; by?: string };
      if (typeof id !== "string" || !id) return json({ error: "id is required" }, 400);
      if (!this.online()) return json({ error: "Computer offline — nothing to withdraw" }, 409);
      this.sendDown({ v: 1, type: "withdraw", id, by });
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

  async webSocketMessage(ws: WebSocket, data: ArrayBuffer | string): Promise<void> {
    if (typeof data !== "string") return;
    // Up-frames only come from the bridge link; phone screen sockets are
    // receive-only (their keepalive is the ping/pong auto-response).
    if (this.ctx.getTags(ws).includes("screen")) return;
    try {
      const frame = JSON.parse(data) as LinkUpFrame;
      if (frame.type === "ack" && typeof frame.id === "string") {
        await this.ctx.storage.delete(`msg:${frame.id}`);
      } else if (frame.type === "queue" && Array.isArray(frame.items)) {
        await this.ctx.storage.put("queue", frame.items.slice(0, 50));
      } else if (frame.type === "roster" && Array.isArray(frame.displays)) {
        // TNGC-35: the wall selector's source of truth. Bounded like the queue.
        await this.ctx.storage.put("roster", frame.displays.slice(0, 32));
      } else if (frame.type === "frame" && typeof frame.display === "string") {
        // TNGC-36: push one server→display message to the user whose
        // tricorder viewscreen this is. Never stored — display frames are
        // ephemeral by design (the phone re-syncs on reconnect).
        if (frame.display.startsWith("tricorder-")) {
          const user = frame.display.slice("tricorder-".length);
          const payload = JSON.stringify(frame.msg);
          for (const s of this.screenSockets(user)) {
            try {
              s.send(payload);
            } catch {
              // dying socket — webSocketClose will tidy up
            }
          }
        }
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

  async webSocketClose(ws: WebSocket): Promise<void> {
    // A phone leaving Viewscreen mode: when its user's LAST screen socket
    // closes, detach the house-side display so it drops from the roster.
    // (Bridge links need no cleanup: getWebSockets() reflects reality,
    // storage is the queue.)
    const tag = this.ctx.getTags(ws).find((t) => t.startsWith("user:"));
    if (!tag) return;
    const user = tag.slice(5);
    // The closing socket can still be in getWebSockets() during this event.
    const remaining = this.screenSockets(user).filter((s) => s !== ws);
    if (remaining.length === 0) {
      this.sendDown({ v: 1, type: "display_close", name: `tricorder-${user}` });
    }
  }
}
