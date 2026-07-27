/**
 * The Games plugin route family (TNGC-61), mounted at /api/plugins/games.
 *
 * These are thin on purpose: authenticate, gate on role and tenant
 * enablement, VALIDATE AND REBUILD the body, then hand a typed request to the
 * DO — which is where the reducer runs under the tenant's single thread.
 *
 * Nothing here decides a game rule. If you find yourself writing one, it
 * belongs in the module.
 */
import { Hono } from "hono";
import type { Env } from "../hub";
import type { Actor, GameMode } from "./engine";
import { catalog, GAME_REGISTRY } from "./registry";

type Role = "admin" | "member" | "guest";

interface Session {
  tenantId: string;
  userId: string;
  userHandle: string;
  name: string;
  deviceLabel: string;
  role: Role;
}

type Vars = { session: Session };

const GAME_ID_RE = /^[a-z0-9-]{1,32}$/;
const WALL_RE = /^[a-z0-9-]{0,32}$/;

/** The actor is ALWAYS the session. A body that names a player is ignored —
    the same rule the calendar follows for created_by. */
function actorOf(s: Session): Actor {
  return { handle: s.userHandle, name: s.name || s.userHandle, role: s.role };
}

export function gamesRoutes(
  hub: (c: { env: Env }, tenantId: string) => DurableObjectStub,
  pluginEnabled: (env: Env, tenantId: string, pluginId: string) => Promise<boolean>,
) {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  // One gate for the whole family: household members only, plugin enabled.
  // Guests are refused for a reason worth stating — the guest account is a
  // single SHARED identity, so two guests on two phones would be one player
  // with one score. Fixing that means device-keyed players, which is its own
  // ticket, not a flag flipped here.
  app.use("*", async (c, next) => {
    const s = c.get("session");
    if (s.role === "guest") return c.json({ error: "the guest account has no plugins" }, 403);
    if (!(await pluginEnabled(c.env, s.tenantId, "games"))) {
      return c.json({ error: "the games plugin is not enabled for this household" }, 403);
    }
    await next();
  });

  const call = async (
    c: { env: Env; get: (k: "session") => Session },
    payload: Record<string, unknown>,
  ): Promise<Response> => {
    const s = c.get("session");
    // The DO cannot derive its own tenant (idFromName is one-way) and needs
    // it to archive a finished match, so it rides along. Not user-supplied.
    return hub({ env: c.env }, s.tenantId).fetch(
      new Request("https://hub/game", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, tenantId: s.tenantId }),
      }),
    );
  };

  const readBody = async (c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> => {
    try {
      const b = (await c.req.json()) as unknown;
      return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  app.get("/catalog", (c) => c.json({ games: catalog() }));

  app.get("/state", async (c) => {
    const raw = Number(c.req.query("since") ?? 0);
    const since = Number.isFinite(raw) && raw > 0 ? Math.min(1000, Math.floor(raw)) : 0;
    return call(c, { kind: "read", actor: actorOf(c.get("session")), since });
  });

  app.post("/match", async (c) => {
    const body = await readBody(c);
    const game = typeof body.game === "string" ? body.game : "";
    if (!GAME_ID_RE.test(game) || !GAME_REGISTRY[game]) return c.json({ error: "no such game" }, 404);
    const mode = body.mode === "coop" || body.mode === "teams" ? (body.mode as GameMode) : undefined;
    const wall = typeof body.wall === "string" && WALL_RE.test(body.wall) ? body.wall : "";
    return call(c, { kind: "create", actor: actorOf(c.get("session")), game, mode, wall });
  });

  app.post("/match/join", (c) => call(c, { kind: "join", actor: actorOf(c.get("session")) }));
  app.post("/match/leave", (c) => call(c, { kind: "leave", actor: actorOf(c.get("session")) }));
  app.post("/match/shuffle", (c) => call(c, { kind: "shuffle", actor: actorOf(c.get("session")) }));
  app.post("/match/end", (c) => call(c, { kind: "end", actor: actorOf(c.get("session")) }));

  app.post("/match/start", async (c) => {
    const body = await readBody(c);
    const mode = body.mode === "coop" || body.mode === "teams" ? (body.mode as GameMode) : undefined;
    return call(c, { kind: "start", actor: actorOf(c.get("session")), mode });
  });

  // Game-specific actions. The op vocabulary belongs to the module, so this
  // route only enforces the envelope: an object, with a short string `op`.
  // The module validates and rebuilds everything inside it.
  app.post("/act", async (c) => {
    const body = await readBody(c);
    if (typeof body.op !== "string" || body.op.length === 0 || body.op.length > 24) {
      return c.json({ error: "op is required" }, 400);
    }
    return call(c, { kind: "act", actor: actorOf(c.get("session")), body });
  });

  app.get("/results", async (c) => {
    const s = c.get("session");
    const rows = await c.env.DB.prepare(
      `SELECT game, mode, players, summary, started_at AS startedAt, ended_at AS endedAt
         FROM game_results WHERE tenant_id = ? ORDER BY ended_at DESC LIMIT 20`,
    )
      .bind(s.tenantId)
      .all();
    return c.json({ results: rows.results ?? [] });
  });

  return app;
}
