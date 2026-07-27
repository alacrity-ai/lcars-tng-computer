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
  CloudControlCommand,
  CloudDisplayCommand,
  CloudMessage,
  ComputerInfo,
  LinkDownFrame,
  LinkUpFrame,
  PluginStatus,
  QueueItem,
  RosterDisplay,
  TngMessage,
} from "@tng/contract";
import { type GameRequest, type Match, reduce } from "./games/engine";
import { GAME_REGISTRY } from "./games/registry";

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
  private controlTimes: number[] = [];
  /** TNGC-61: game traffic is polled, so it gets its own generous fuse rather
      than sharing the voice or lights windows. */
  private gameTimes: number[] = [];
  /** Wall-paint throttle — a drawing hand must not strobe the television. */
  private lastWallPaint = 0;

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
      await this.ctx.storage.delete("computer");
      await this.ctx.storage.delete("plugins");
      await this.ctx.storage.delete("plugin_state");
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
      const computer = this.online()
        ? await this.ctx.storage.get<ComputerInfo>("computer")
        : undefined;
      return json({
        online: this.online(),
        queued: await this.depth(),
        pending: (await this.queueItems()).length,
        // TNGC-35: the house's live viewscreens (bridge-reported). Offline →
        // empty, like the queue — a stale roster is worse than none.
        displays: this.online()
          ? ((await this.ctx.storage.get<RosterDisplay[]>("roster")) ?? [])
          : [],
        // TNGC-32: every phone shows the consolidation banner, not just admins
        compacting: computer?.compacting === true,
      });
    }

    // TNGC-32: the session's context/compaction state as last reported by
    // the bridge (admin console reads this; role enforced in the Worker).
    if (url.pathname === "/computer") {
      const info = await this.ctx.storage.get<ComputerInfo>("computer");
      return json({ online: this.online(), computer: this.online() ? (info ?? null) : null });
    }

    // TNGC-32 follow-up: admin set model/effort — relay to the bridge (role
    // AND value validated in the Worker). Ephemeral like withdraw.
    if (url.pathname === "/set-pref" && req.method === "POST") {
      if (!this.online()) return json({ error: "Computer offline" }, 409);
      const { kind, value, by } = (await req.json()) as { kind?: "model" | "effort"; value?: string; by?: string };
      if ((kind !== "model" && kind !== "effort") || typeof value !== "string") {
        return json({ error: "kind and value are required" }, 400);
      }
      this.sendDown({ v: 1, type: "set_pref", kind, value, by });
      return json({ ok: true }, 202);
    }

    // TNGC-32: admin pressed Compact — relay to the bridge (role enforced in
    // the Worker). Ephemeral like withdraw: no storage, no replay.
    if (url.pathname === "/compact" && req.method === "POST") {
      if (!this.online()) return json({ error: "Computer offline" }, 409);
      const info = await this.ctx.storage.get<ComputerInfo>("computer");
      if (info?.compacting) return json({ error: "consolidation already in progress" }, 409);
      const { by } = (await req.json()) as { by?: string };
      this.sendDown({ v: 1, type: "compact", by });
      return json({ ok: true }, 202);
    }

    if (url.pathname === "/queue") {
      return json({ online: this.online(), items: await this.queueItems() });
    }

    // ---- tricorder plugins (TNGC-40) ----------------------------------------
    // The bridge-probed roster and per-plugin state snapshots. Offline reads
    // as empty/absent, like the queue — stale plugin state is worse than none.

    if (url.pathname === "/plugins") {
      const plugins = this.online()
        ? ((await this.ctx.storage.get<PluginStatus[]>("plugins")) ?? [])
        : [];
      return json({ online: this.online(), plugins });
    }

    if (url.pathname === "/plugin-state") {
      const plugin = url.searchParams.get("plugin") ?? "";
      const map = this.online()
        ? ((await this.ctx.storage.get<Record<string, unknown>>("plugin_state")) ?? {})
        : {};
      return json({ online: this.online(), state: map[plugin] ?? null });
    }

    // A control op: ephemeral by contract — pushed down the live link or
    // rejected, never stored, never replayed. Permissions and argument
    // validation happened in the Worker; the bridge re-validates regardless.
    if (url.pathname === "/control" && req.method === "POST") {
      if (!this.online()) return json({ error: "Computer offline" }, 409);
      // Same style of flood fuse as /enqueue, sized for a lights panel (a
      // scrubber applies on release, so people generate a few ops a minute).
      const now = Date.now();
      this.controlTimes = this.controlTimes.filter((t) => now - t < 60_000);
      if (this.controlTimes.length >= 60) {
        return json({ error: "rate limit — slow down" }, 429);
      }
      this.controlTimes.push(now);
      const ctl = (await req.json()) as CloudControlCommand;
      this.sendDown({ v: 1, type: "control", ctl });
      return json({ ok: true }, 202);
    }

    if (url.pathname === "/withdraw" && req.method === "POST") {
      const { id, by } = (await req.json()) as { id?: string; by?: string };
      if (typeof id !== "string" || !id) return json({ error: "id is required" }, 400);
      if (!this.online()) return json({ error: "Computer offline — nothing to withdraw" }, 409);
      this.sendDown({ v: 1, type: "withdraw", id, by });
      return json({ ok: true }, 202);
    }

    // ---- games (TNGC-61) ----------------------------------------------------
    // The DO is the authoritative game server: single-threaded per tenant, so
    // two guesses milliseconds apart are ordered by arrival with no clock to
    // trust and no lock to take. The rules themselves are a pure reducer —
    // this is only the transaction around it.
    if (url.pathname === "/game" && req.method === "POST") {
      const now = Date.now();
      // Sized for play, not for voice: a household of eight polling at 700 ms
      // is ~11 req/s. Deliberately NOT the /enqueue or /control fuses, which
      // would cut a game off mid-turn.
      this.gameTimes = this.gameTimes.filter((t) => now - t < 60_000);
      if (this.gameTimes.length >= 900) {
        return json({ error: "rate limit — slow down" }, 429);
      }
      this.gameTimes.push(now);
      const payload = (await req.json()) as GameRequest & { tenantId?: string };
      // The DO cannot derive its own tenant (idFromName is one-way), so the
      // Worker tells it and we remember — the alarm path has no request to
      // read it from.
      if (typeof payload.tenantId === "string" && payload.tenantId) {
        await this.ctx.storage.put("tenant_id", payload.tenantId);
      }
      return this.runGame(payload, now);
    }

    return json({ error: "not found" }, 404);
  }

  /**
   * The turn clock. Games own the hub's alarm — nothing else used one when
   * this landed, and `endsAt` is set on EVERY match phase so re-arming is one
   * line. If another feature ever needs an alarm here, it has to share this
   * handler rather than call setAlarm behind its back.
   */
  async alarm(): Promise<void> {
    await this.runGame({ kind: "expire" }, Date.now());
  }

  /** Load → reduce → persist → re-arm → paint. */
  private async runGame(request: GameRequest, now: number): Promise<Response> {
    const match = (await this.ctx.storage.get<Match>("game:match")) ?? null;
    const out = reduce(match, request, now, GAME_REGISTRY);

    if (out.match !== undefined) {
      if (out.match === null) {
        await this.ctx.storage.delete("game:match");
        await this.ctx.storage.deleteAlarm();
      } else {
        await this.ctx.storage.put("game:match", out.match);
        await this.ctx.storage.setAlarm(out.match.endsAt);
      }
    }

    if (out.finished) {
      // The epitaph, not the state. A failure here must not cost anyone their
      // game, so it is logged and swallowed.
      try {
        const f = out.finished;
        await this.env.DB.prepare(
          `INSERT INTO game_results (id, tenant_id, game, mode, players, summary, detail, started_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            crypto.randomUUID(),
            await this.tenantId(),
            f.game,
            f.mode,
            f.players,
            f.summary.slice(0, 200),
            JSON.stringify(f.detail).slice(0, 8000),
            f.startedAt,
            f.endedAt,
          )
          .run();
      } catch (e) {
        console.log(`[hub] game result not archived: ${(e as Error).message}`);
      }
    }

    if (out.wall) this.paintWall(out.wall, out.match ?? match, now);
    return json(out.body, out.status);
  }

  /** Which tenant this DO belongs to — stashed by the first game request,
      which is the only caller that needs it. */
  private async tenantId(): Promise<string> {
    return (await this.ctx.storage.get<string>("tenant_id")) ?? "unknown";
  }

  /**
   * Push a panel to the house wall, deterministically — no session turn, no
   * library item. Fire-and-forget: the game is fully playable with the wall
   * dark, so a missing link is not an error, and frames are throttled because
   * a drawing hand would otherwise strobe the television.
   */
  private paintWall(frame: { view: string; props: unknown }, match: Match | null, now: number): void {
    if (!this.online()) return;
    if (now - this.lastWallPaint < 500) return;
    this.lastWallPaint = now;
    this.sendDown({
      v: 1,
      type: "display_props",
      view: frame.view,
      props: frame.props,
      ...(match?.wall ? { wall: match.wall } : {}),
    });
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
    // Phone screen sockets may report PLAYER EVENTS only (video_ended /
    // video_error — what advances a playlist's queue on the phone); the
    // whitelist keeps them from speaking as a wall in any other way.
    // Everything else on a screen socket is dropped.
    const tags = this.ctx.getTags(ws);
    if (tags.includes("screen")) {
      const user = tags.find((t) => t.startsWith("user:"))?.slice(5);
      if (!user) return;
      try {
        const msg = JSON.parse(data) as { type?: unknown; videoId?: unknown };
        if (
          (msg.type === "video_ended" || msg.type === "video_error") &&
          typeof msg.videoId === "string" &&
          msg.videoId.length <= 16
        ) {
          this.sendDown({ v: 1, type: "display_client", name: `tricorder-${user}`, msg });
        }
      } catch {
        // not JSON — ignore
      }
      return;
    }
    try {
      const frame = JSON.parse(data) as LinkUpFrame;
      if (frame.type === "ack" && typeof frame.id === "string") {
        await this.ctx.storage.delete(`msg:${frame.id}`);
      } else if (frame.type === "queue" && Array.isArray(frame.items)) {
        await this.ctx.storage.put("queue", frame.items.slice(0, 50));
      } else if (frame.type === "roster" && Array.isArray(frame.displays)) {
        // TNGC-35: the wall selector's source of truth. Bounded like the queue.
        await this.ctx.storage.put("roster", frame.displays.slice(0, 32));
      } else if (frame.type === "computer" && frame.info && typeof frame.info === "object") {
        // TNGC-32: context meter + compaction state for the admin console.
        await this.ctx.storage.put("computer", frame.info);
      } else if (frame.type === "plugins" && Array.isArray(frame.plugins)) {
        // TNGC-40: the bridge-probed plugin roster. Bounded like the queue.
        await this.ctx.storage.put("plugins", frame.plugins.slice(0, 16));
      } else if (frame.type === "plugin_state" && typeof frame.plugin === "string" && frame.plugin.length <= 32) {
        // TNGC-40: one plugin's live state snapshot, keyed in a single map.
        const map = (await this.ctx.storage.get<Record<string, unknown>>("plugin_state")) ?? {};
        if (frame.plugin in map || Object.keys(map).length < 16) {
          map[frame.plugin] = frame.state;
          await this.ctx.storage.put("plugin_state", map);
        }
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
