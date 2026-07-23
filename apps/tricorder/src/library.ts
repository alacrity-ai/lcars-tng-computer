/**
 * Tricorder Library (TNGC-23) — save / browse / send / redisplay wall
 * primitives. D1 holds the metadata index (search/browse never touch
 * payloads); R2 holds the props JSON, fronted EXCLUSIVELY by these routes —
 * the bucket is never exposed directly to the house or the phone.
 *
 * Two auth planes on the same routes:
 *  - session (PWA bearer token) — a user acting on their OWN items
 *  - service (the tenant service token, same credential as /link) — the
 *    house acting for a named owner; trusted within its tenant, because the
 *    Worker cannot know which household member spoke at the wall
 * Guests have no library: no saves, no receives, 403 across the board.
 */
import { Hono } from "hono";
import type { CloudDisplayCommand } from "@tng/contract";
import type { Env } from "./hub";
import { sha256Hex } from "./auth";

/** view → browse family. Views absent here (status, alert, blank, boot) are
    not savable — they are navigation/transients, not artifacts. */
const FAMILY_BY_VIEW: Record<string, string> = {
  text: "prose", article: "prose", news: "prose", results: "prose",
  chart: "data", table: "data", quote: "data", scoreboard: "data",
  weather: "data", timeline: "data",
  diagram: "visual", image: "visual", map: "visual", "night-sky": "visual",
  steps: "procedure", quiz: "procedure",
  code: "notation", math: "notation",
  composite: "data",
  youtube: "media",
  // Not a wall panel: a restorable play-queue snapshot (TNGC-25). The house
  // display route turns it back into now-playing + queue.
  playlist: "media",
};
const FAMILIES = [...new Set(Object.values(FAMILY_BY_VIEW))];

const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_ITEMS_PER_OWNER = 500;
const MAX_TITLE_CHARS = 200;
const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;

type Role = "admin" | "member" | "guest";

/** Who is calling: the house (service token) or a person (session). */
type Actor =
  | { kind: "service"; tenantId: string }
  | {
      kind: "session";
      tenantId: string;
      userId: string;
      userHandle: string;
      deviceLabel: string;
      role: Role;
    };

interface ItemRow {
  id: string;
  ownerId: string;
  family: string;
  view: string;
  title: string;
  r2Key: string;
  bytes: number;
  fromUser: string | null;
  createdAt: number;
}

type Vars = { actor: Actor };

const ITEM_COLS =
  "id, owner_id AS ownerId, family, view, title, r2_key AS r2Key, bytes, from_user AS fromUser, created_at AS createdAt";

function meta(row: ItemRow) {
  const { r2Key: _r2, ownerId: _o, ...pub } = row;
  return pub;
}

/** LIKE pattern with user input neutralized (\ as the escape char). */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

async function findUserByHandle(env: Env, tenantId: string, handle: string) {
  return env.DB.prepare(
    "SELECT id, handle, role, disabled FROM users WHERE tenant_id = ? AND handle = ?",
  )
    .bind(tenantId, handle.trim().toLowerCase())
    .first<{ id: string; handle: string; role: Role; disabled: number }>();
}

async function ownerItemCount(env: Env, tenantId: string, ownerId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM library_items WHERE tenant_id = ? AND owner_id = ?",
  )
    .bind(tenantId, ownerId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function getItemRow(env: Env, tenantId: string, id: string): Promise<ItemRow | null> {
  return env.DB.prepare(`SELECT ${ITEM_COLS} FROM library_items WHERE tenant_id = ? AND id = ?`)
    .bind(tenantId, id)
    .first<ItemRow>();
}

/** May this actor touch this item? Sessions: own items (admin: any).
    Service: any item in the tenant — the house is the tenant's own device. */
function canTouch(actor: Actor, row: ItemRow): boolean {
  if (actor.kind === "service") return true;
  return row.ownerId === actor.userId || actor.role === "admin";
}

/** The mounted sub-app: `app.route("/api/library", libraryRoutes(...))` in
    the Worker, registered BEFORE the /api/* session gate — like /api/login,
    it owns its own auth. */
export function libraryRoutes(
  resolveSession: (env: Env, req: Request) => Promise<
    | { tenantId: string; userId: string; userHandle: string; deviceLabel: string; role: Role }
    | null
  >,
  hub: (c: { env: Env }, tenantId: string) => DurableObjectStub,
) {
  const lib = new Hono<{ Bindings: Env; Variables: Vars }>();

  // ---- auth: service token first, then session; guests are bounced --------
  lib.use("*", async (c, next) => {
    const header = c.req.raw.headers.get("authorization");
    const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (token) {
      const tenant = await c.env.DB.prepare("SELECT id FROM tenants WHERE service_token_hash = ?")
        .bind(await sha256Hex(token))
        .first<{ id: string }>();
      if (tenant) {
        c.set("actor", { kind: "service", tenantId: tenant.id });
        return next();
      }
    }
    const s = await resolveSession(c.env, c.req.raw);
    if (!s) return c.json({ error: "unauthorized" }, 401);
    if (s.role === "guest") return c.json({ error: "the guest account has no library" }, 403);
    c.set("actor", { kind: "session", ...s });
    return next();
  });

  // ---- ingest (house → cloud; the save path) -------------------------------
  lib.post("/", async (c) => {
    const actor = c.get("actor");
    if (actor.kind !== "service") {
      return c.json({ error: "saves come from the wall — service token only" }, 403);
    }
    let body: { owner?: unknown; view?: unknown; title?: unknown; props?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const view = typeof body.view === "string" ? body.view : "";
    const family = FAMILY_BY_VIEW[view];
    if (!family) return c.json({ error: `view "${view}" is not savable` }, 400);
    const title =
      typeof body.title === "string" && body.title.trim()
        ? body.title.trim().slice(0, MAX_TITLE_CHARS)
        : "";
    if (!title) return c.json({ error: "title is required" }, 400);
    if (typeof body.owner !== "string" || !body.owner.trim()) {
      return c.json({ error: "owner (handle) is required" }, 400);
    }
    if (typeof body.props !== "object" || body.props === null || Array.isArray(body.props)) {
      return c.json({ error: "props (object) is required" }, 400);
    }
    const payload = JSON.stringify(body.props);
    const bytes = new TextEncoder().encode(payload).length;
    if (bytes > MAX_PAYLOAD_BYTES) {
      return c.json({ error: `payload too large (${bytes} bytes, max ${MAX_PAYLOAD_BYTES})` }, 413);
    }

    const owner = await findUserByHandle(c.env, actor.tenantId, body.owner);
    if (!owner || owner.disabled) return c.json({ error: `no such user "${body.owner}"` }, 404);
    if (owner.role === "guest") return c.json({ error: "the guest account has no library" }, 403);
    if ((await ownerItemCount(c.env, actor.tenantId, owner.id)) >= MAX_ITEMS_PER_OWNER) {
      return c.json({ error: `library full (${MAX_ITEMS_PER_OWNER} items) — delete something first` }, 409);
    }

    const id = `li_${crypto.randomUUID().slice(0, 8)}`;
    const r2Key = `lib/${actor.tenantId}/${id}.json`;
    await c.env.LIBRARY.put(r2Key, payload, {
      httpMetadata: { contentType: "application/json" },
    });
    await c.env.DB.prepare(
      `INSERT INTO library_items (id, tenant_id, owner_id, family, view, title, r2_key, bytes, from_user, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
      .bind(id, actor.tenantId, owner.id, family, view, title, r2Key, bytes, Date.now())
      .run();
    return c.json({ id, title, family, view, bytes }, 201);
  });

  // ---- browse / search (metadata only, cursor-paged) -----------------------
  lib.get("/", async (c) => {
    const actor = c.get("actor");
    let ownerId: string;
    if (actor.kind === "session") {
      ownerId = actor.userId;
    } else {
      const handle = c.req.query("owner") ?? "";
      if (!handle) return c.json({ error: "owner (handle) is required on the service plane" }, 400);
      const owner = await findUserByHandle(c.env, actor.tenantId, handle);
      if (!owner) return c.json({ error: `no such user "${handle}"` }, 404);
      ownerId = owner.id;
    }

    const conds = ["tenant_id = ?", "owner_id = ?"];
    const binds: unknown[] = [actor.tenantId, ownerId];
    const family = c.req.query("family");
    if (family) {
      if (!FAMILIES.includes(family)) {
        return c.json({ error: `family must be one of: ${FAMILIES.join(", ")}` }, 400);
      }
      conds.push("family = ?");
      binds.push(family);
    }
    const q = c.req.query("q")?.trim();
    if (q) {
      conds.push("title LIKE ? ESCAPE '\\'");
      binds.push(likePattern(q));
    }
    if (c.req.query("received") === "1") conds.push("from_user IS NOT NULL");
    const where = conds.join(" AND ");

    const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM library_items WHERE ${where}`)
      .bind(...binds)
      .first<{ n: number }>();

    const before = Number(c.req.query("before"));
    if (Number.isFinite(before) && before > 0) {
      conds.push("created_at < ?");
      binds.push(before);
    }
    const limit = Math.min(
      MAX_LIST_LIMIT,
      Math.max(1, Math.trunc(Number(c.req.query("limit")) || DEFAULT_LIST_LIMIT)),
    );
    const rows = await c.env.DB.prepare(
      `SELECT ${ITEM_COLS} FROM library_items WHERE ${conds.join(" AND ")}
        ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(...binds, limit)
      .all<ItemRow>();

    const items = rows.results.map(meta);
    return c.json({
      items,
      total: total?.n ?? items.length,
      nextBefore: items.length === limit ? items[items.length - 1].createdAt : null,
    });
  });

  // ---- one item, metadata + payload ----------------------------------------
  lib.get("/:id", async (c) => {
    const actor = c.get("actor");
    const row = await getItemRow(c.env, actor.tenantId, c.req.param("id"));
    if (!row || !canTouch(actor, row)) return c.json({ error: "no such item" }, 404);
    const obj = await c.env.LIBRARY.get(row.r2Key);
    if (!obj) return c.json({ error: "payload missing from storage" }, 404);
    const props = (await obj.json()) as Record<string, unknown>;
    return c.json({ item: meta(row), props });
  });

  lib.delete("/:id", async (c) => {
    const actor = c.get("actor");
    const row = await getItemRow(c.env, actor.tenantId, c.req.param("id"));
    if (!row || !canTouch(actor, row)) return c.json({ error: "no such item" }, 404);
    await c.env.DB.prepare("DELETE FROM library_items WHERE id = ?").bind(row.id).run();
    await c.env.LIBRARY.delete(row.r2Key);
    return c.json({ ok: true });
  });

  // ---- send a copy to another user -----------------------------------------
  lib.post("/:id/send", async (c) => {
    const actor = c.get("actor");
    const row = await getItemRow(c.env, actor.tenantId, c.req.param("id"));
    if (!row || !canTouch(actor, row)) return c.json({ error: "no such item" }, 404);
    let body: { to?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.to !== "string" || !body.to.trim()) {
      return c.json({ error: "to (handle) is required" }, 400);
    }
    const to = await findUserByHandle(c.env, actor.tenantId, body.to);
    if (!to || to.disabled) return c.json({ error: `no such user "${body.to}"` }, 404);
    if (to.role === "guest") return c.json({ error: "the guest account has no library" }, 403);
    if (to.id === row.ownerId) return c.json({ error: "that is already their item" }, 400);
    if ((await ownerItemCount(c.env, actor.tenantId, to.id)) >= MAX_ITEMS_PER_OWNER) {
      return c.json({ error: `${to.handle}'s library is full` }, 409);
    }
    // Provenance: the copy names the SOURCE item's owner as sender — on the
    // service plane the Worker can't know who spoke, but "send this to Ariel"
    // always sends the speaker's own item.
    const sender = await c.env.DB.prepare("SELECT handle FROM users WHERE id = ?")
      .bind(row.ownerId)
      .first<{ handle: string }>();
    const src = await c.env.LIBRARY.get(row.r2Key);
    if (!src) return c.json({ error: "payload missing from storage" }, 404);

    const id = `li_${crypto.randomUUID().slice(0, 8)}`;
    const r2Key = `lib/${actor.tenantId}/${id}.json`;
    // An immutable snapshot: later edits/deletes of the original never touch it.
    await c.env.LIBRARY.put(r2Key, await src.arrayBuffer(), {
      httpMetadata: { contentType: "application/json" },
    });
    await c.env.DB.prepare(
      `INSERT INTO library_items (id, tenant_id, owner_id, family, view, title, r2_key, bytes, from_user, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, actor.tenantId, to.id, row.family, row.view, row.title, r2Key, row.bytes,
            sender?.handle ?? "unknown", Date.now())
      .run();
    return c.json({ id, to: to.handle, title: row.title }, 201);
  });

  // ---- display on the wall (phone-initiated; rides the visible queue) ------
  lib.post("/:id/display", async (c) => {
    const actor = c.get("actor");
    if (actor.kind !== "session") {
      return c.json({ error: "the house displays via its console, not this route" }, 403);
    }
    const row = await getItemRow(c.env, actor.tenantId, c.req.param("id"));
    if (!row || !canTouch(actor, row)) return c.json({ error: "no such item" }, 404);
    const cmd: CloudDisplayCommand = {
      id: crypto.randomUUID(),
      itemId: row.id,
      view: row.view,
      title: row.title,
      user: actor.userHandle,
      device: actor.deviceLabel,
      ts: Date.now(),
    };
    const res = await hub(c, actor.tenantId).fetch(
      new Request("https://hub/display-item", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cmd),
      }),
    );
    return new Response(res.body, { status: res.status, headers: res.headers });
  });

  return lib;
}
