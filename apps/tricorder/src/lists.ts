/**
 * Family lists API (TNGC-63) — tenant-scoped checklists in D1.
 *
 * Two auth planes, exactly the calendar's (TNGC-46/52):
 *  - service (tenant service token) — the Computer's `lists` tool; carries
 *    the speaking user in the body for attribution.
 *  - session (PWA bearer) — household members (admin/member) get full CRUD;
 *    attribution is the session's own handle, never body-supplied. Guests
 *    are bounced at the door.
 *
 * Checked items keep their row (struck on the panel) until clear-completed —
 * a list you can't see shrink isn't satisfying to finish. `checked_by`
 * records who claimed the item.
 */
import { Hono } from "hono";
import type { Env } from "./hub";
import { sha256Hex } from "./auth";

type Role = "admin" | "member" | "guest";

type Actor =
  | { kind: "service"; tenantId: string }
  | { kind: "session"; tenantId: string; userId: string; userHandle: string; deviceLabel: string; role: Role };

type Vars = { actor: Actor };

// Kept in sync by hand with LIST_CATEGORIES in @tng/shared (panel color
// accents). Lenient: unknown categories store as NULL, never rejected.
const CATEGORIES = new Set(["shopping", "chores", "todo", "packing", "other"]);

const MAX_NAME = 60;
const MAX_ITEM = 200;
const MAX_LISTS_PER_TENANT = 50;
const MAX_ITEMS_PER_LIST = 200;

interface ListRow {
  id: string;
  name: string;
  category: string | null;
  createdBy: string;
  updatedAt: number;
}

interface ItemRow {
  id: string;
  text: string;
  checked: number;
  checkedBy: string | null;
  createdBy: string;
  createdAt: number;
}

const LIST_COLS = "id, name, category, created_by AS createdBy, updated_at AS updatedAt";
const ITEM_COLS =
  "id, text, checked, checked_by AS checkedBy, created_by AS createdBy, created_at AS createdAt";

const publicItem = (i: ItemRow) => ({
  id: i.id,
  text: i.text,
  checked: i.checked === 1,
  checkedBy: i.checkedBy,
  createdBy: i.createdBy,
});

function cleanName(raw: unknown): string | null {
  const n = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  return n && n.length <= MAX_NAME ? n : null;
}

function cleanCategory(raw: unknown): string | null {
  const c = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return CATEGORIES.has(c) ? c : null;
}

/** Attribution: a session write IS the member; the service plane passes the
    speaking user through (default "computer"). */
function actorHandle(actor: Actor, body: Record<string, unknown>): string {
  if (actor.kind === "session") return actor.userHandle.slice(0, 40);
  const by = body.by ?? body.createdBy;
  return typeof by === "string" && by.trim() ? by.trim().toLowerCase().slice(0, 40) : "computer";
}

export function listsRoutes(
  resolveSession: (
    env: Env,
    req: Request,
  ) => Promise<{ tenantId: string; userId: string; userHandle: string; deviceLabel: string; role: Role } | null>,
) {
  const lists = new Hono<{ Bindings: Env; Variables: Vars }>();

  lists.use("*", async (c, next) => {
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
    if (s.role === "guest") return c.json({ error: "the guest account has no lists" }, 403);
    c.set("actor", { kind: "session", ...s });
    return next();
  });

  /** Load a list row scoped to the tenant, or null. */
  const getList = (c: { env: Env }, tenantId: string, id: string) =>
    c.env.DB.prepare(`SELECT ${LIST_COLS} FROM lists WHERE tenant_id = ? AND id = ?`)
      .bind(tenantId, id)
      .first<ListRow>();

  // ---- index: every list with progress counts ------------------------------
  lists.get("/", async (c) => {
    const actor = c.get("actor");
    const rows = await c.env.DB.prepare(
      `SELECT l.id, l.name, l.category, l.created_by AS createdBy, l.updated_at AS updatedAt,
              COUNT(i.id) AS total, SUM(CASE WHEN i.checked = 1 THEN 1 ELSE 0 END) AS done
         FROM lists l LEFT JOIN list_items i ON i.list_id = l.id
        WHERE l.tenant_id = ?
        GROUP BY l.id ORDER BY l.name COLLATE NOCASE`,
    )
      .bind(actor.tenantId)
      .all<ListRow & { total: number; done: number | null }>();
    return c.json({
      lists: rows.results.map((r) => ({ ...r, done: r.done ?? 0 })),
    });
  });

  // ---- create a list -------------------------------------------------------
  lists.post("/", async (c) => {
    const actor = c.get("actor");
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const name = cleanName(body.name);
    if (!name) return c.json({ error: `name is required (max ${MAX_NAME} chars)` }, 400);
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM lists WHERE tenant_id = ?")
      .bind(actor.tenantId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_LISTS_PER_TENANT) {
      return c.json({ error: `too many lists (${MAX_LISTS_PER_TENANT})` }, 409);
    }
    const id = `ls_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();
    try {
      await c.env.DB.prepare(
        "INSERT INTO lists (id, tenant_id, name, category, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(id, actor.tenantId, name, cleanCategory(body.category), actorHandle(actor, body), now, now)
        .run();
    } catch (err) {
      if (String(err).includes("UNIQUE")) {
        return c.json({ error: `a list named "${name}" already exists` }, 409);
      }
      throw err;
    }
    const row = await getList(c, actor.tenantId, id);
    return c.json({ list: { ...row, total: 0, done: 0 } }, 201);
  });

  // ---- one list with its items --------------------------------------------
  lists.get("/:id", async (c) => {
    const actor = c.get("actor");
    const list = await getList(c, actor.tenantId, c.req.param("id"));
    if (!list) return c.json({ error: "no such list" }, 404);
    const items = await c.env.DB.prepare(
      `SELECT ${ITEM_COLS} FROM list_items WHERE tenant_id = ? AND list_id = ? ORDER BY created_at, id`,
    )
      .bind(actor.tenantId, list.id)
      .all<ItemRow>();
    return c.json({ list, items: items.results.map(publicItem) });
  });

  // ---- rename / recategorize ----------------------------------------------
  lists.post("/:id", async (c) => {
    const actor = c.get("actor");
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) {
      const name = cleanName(body.name);
      if (!name) return c.json({ error: `name must be 1..${MAX_NAME} chars` }, 400);
      sets.push("name = ?");
      values.push(name);
    }
    if (body.category !== undefined) {
      sets.push("category = ?");
      values.push(cleanCategory(body.category));
    }
    if (!sets.length) return c.json({ error: "nothing to update" }, 400);
    let res;
    try {
      res = await c.env.DB.prepare(
        `UPDATE lists SET ${sets.join(", ")}, updated_at = ? WHERE tenant_id = ? AND id = ?`,
      )
        .bind(...values, Date.now(), actor.tenantId, c.req.param("id"))
        .run();
    } catch (err) {
      if (String(err).includes("UNIQUE")) return c.json({ error: "that name is taken" }, 409);
      throw err;
    }
    if (!res.meta.changes) return c.json({ error: "no such list" }, 404);
    return c.json({ list: await getList(c, actor.tenantId, c.req.param("id")) });
  });

  // ---- delete a list (and its items) --------------------------------------
  lists.delete("/:id", async (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    const res = await c.env.DB.prepare("DELETE FROM lists WHERE tenant_id = ? AND id = ?")
      .bind(actor.tenantId, id)
      .run();
    if (!res.meta.changes) return c.json({ error: "no such list" }, 404);
    await c.env.DB.prepare("DELETE FROM list_items WHERE tenant_id = ? AND list_id = ?")
      .bind(actor.tenantId, id)
      .run();
    return c.json({ ok: true });
  });

  // ---- add an item ---------------------------------------------------------
  lists.post("/:id/items", async (c) => {
    const actor = c.get("actor");
    const list = await getList(c, actor.tenantId, c.req.param("id"));
    if (!list) return c.json({ error: "no such list" }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const text = typeof body.text === "string" ? body.text.trim().replace(/\s+/g, " ") : "";
    if (!text || text.length > MAX_ITEM) {
      return c.json({ error: `text is required (max ${MAX_ITEM} chars)` }, 400);
    }
    const count = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM list_items WHERE tenant_id = ? AND list_id = ?",
    )
      .bind(actor.tenantId, list.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_ITEMS_PER_LIST) {
      return c.json({ error: `list is full (${MAX_ITEMS_PER_LIST} items)` }, 409);
    }
    const id = `li_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO list_items (id, tenant_id, list_id, text, checked, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
      ).bind(id, actor.tenantId, list.id, text, actorHandle(actor, body), now, now),
      c.env.DB.prepare("UPDATE lists SET updated_at = ? WHERE id = ?").bind(now, list.id),
    ]);
    const row = await c.env.DB.prepare(`SELECT ${ITEM_COLS} FROM list_items WHERE id = ?`)
      .bind(id)
      .first<ItemRow>();
    return c.json({ item: publicItem(row!) }, 201);
  });

  // ---- edit / check / uncheck an item -------------------------------------
  lists.post("/:id/items/:itemId", async (c) => {
    const actor = c.get("actor");
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    if (body.text !== undefined) {
      const text = typeof body.text === "string" ? body.text.trim().replace(/\s+/g, " ") : "";
      if (!text || text.length > MAX_ITEM) return c.json({ error: `text must be 1..${MAX_ITEM} chars` }, 400);
      sets.push("text = ?");
      values.push(text);
    }
    if (body.checked !== undefined) {
      if (typeof body.checked !== "boolean") return c.json({ error: "checked must be boolean" }, 400);
      sets.push("checked = ?", "checked_by = ?", "checked_at = ?");
      values.push(
        body.checked ? 1 : 0,
        body.checked ? actorHandle(actor, body) : null,
        body.checked ? Date.now() : null,
      );
    }
    if (!sets.length) return c.json({ error: "nothing to update" }, 400);
    const now = Date.now();
    const res = await c.env.DB.prepare(
      `UPDATE list_items SET ${sets.join(", ")}, updated_at = ? WHERE tenant_id = ? AND list_id = ? AND id = ?`,
    )
      .bind(...values, now, actor.tenantId, c.req.param("id"), c.req.param("itemId"))
      .run();
    if (!res.meta.changes) return c.json({ error: "no such item" }, 404);
    await c.env.DB.prepare("UPDATE lists SET updated_at = ? WHERE tenant_id = ? AND id = ?")
      .bind(now, actor.tenantId, c.req.param("id"))
      .run();
    const row = await c.env.DB.prepare(`SELECT ${ITEM_COLS} FROM list_items WHERE id = ?`)
      .bind(c.req.param("itemId"))
      .first<ItemRow>();
    return c.json({ item: publicItem(row!) });
  });

  // ---- remove an item ------------------------------------------------------
  lists.delete("/:id/items/:itemId", async (c) => {
    const actor = c.get("actor");
    const res = await c.env.DB.prepare(
      "DELETE FROM list_items WHERE tenant_id = ? AND list_id = ? AND id = ?",
    )
      .bind(actor.tenantId, c.req.param("id"), c.req.param("itemId"))
      .run();
    if (!res.meta.changes) return c.json({ error: "no such item" }, 404);
    return c.json({ ok: true });
  });

  // ---- clear completed -----------------------------------------------------
  lists.post("/:id/clear-completed", async (c) => {
    const actor = c.get("actor");
    const list = await getList(c, actor.tenantId, c.req.param("id"));
    if (!list) return c.json({ error: "no such list" }, 404);
    const res = await c.env.DB.prepare(
      "DELETE FROM list_items WHERE tenant_id = ? AND list_id = ? AND checked = 1",
    )
      .bind(actor.tenantId, list.id)
      .run();
    return c.json({ ok: true, cleared: res.meta.changes });
  });

  return lists;
}
