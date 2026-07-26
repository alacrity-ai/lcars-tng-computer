/**
 * The family calendar API (TNGC-46) — tenant-scoped events in D1.
 *
 * Two auth planes, mirroring the Library:
 *  - service (the tenant service token) — the house: full CRUD. The brain's
 *    `calendar` MCP tool is the only writer this era.
 *  - session (PWA bearer token) — household members read; guests are bounced.
 *    Member writes arrive with the deterministic tricorder plugin follow-up.
 *
 * Times are WALL-CLOCK LOCAL strings (YYYY-MM-DD / HH:MM) — a house calendar
 * has one clock; timezone conversion would only invent bugs. Category is a
 * lenient vocabulary: unknown values store as NULL, search never depends on
 * it (the model scans the clean event list), panels use it for color only.
 */
import { Hono } from "hono";
import type { Env } from "./hub";
import { sha256Hex } from "./auth";

type Role = "admin" | "member" | "guest";

type Actor =
  | { kind: "service"; tenantId: string }
  | { kind: "session"; tenantId: string; userId: string; userHandle: string; deviceLabel: string; role: Role };

type Vars = { actor: Actor };

// Kept in sync by hand with CALENDAR_CATEGORIES in @tng/shared (the panels'
// color vocabulary). Lenient on purpose — a category the wall can't color is
// stored as NULL, never rejected.
const CATEGORIES = new Set(["medical", "school", "work", "social", "travel", "birthday", "family", "chore", "other"]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_TITLE = 120;
const MAX_LOCATION = 120;
const MAX_NOTES = 500;
const MAX_EVENTS_PER_TENANT = 2000;
const MAX_RANGE_DAYS = 400;

interface EventRow {
  id: string;
  title: string;
  date: string;
  time: string | null;
  endTime: string | null;
  location: string | null;
  category: string | null;
  notes: string | null;
  createdBy: string;
}

const EVENT_COLS =
  "id, title, date, time, end_time AS endTime, location, category, notes, created_by AS createdBy";

/** A calendar-real date, not just a well-shaped one (rejects 2026-02-30). */
function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Validate + normalize one event's writable fields. Returns clean values or
    an error string. `partial` skips required-field checks (updates). */
function cleanFields(
  body: Record<string, unknown>,
  partial: boolean,
): { error: string } | { fields: Record<string, string | null> } {
  const out: Record<string, string | null> = {};
  if (body.title !== undefined || !partial) {
    const t = typeof body.title === "string" ? body.title.trim() : "";
    if (!t || t.length > MAX_TITLE) return { error: `title is required (max ${MAX_TITLE} chars)` };
    out.title = t;
  }
  if (body.date !== undefined || !partial) {
    const d = typeof body.date === "string" ? body.date.trim() : "";
    if (!validDate(d)) return { error: "date must be a real YYYY-MM-DD" };
    out.date = d;
  }
  for (const key of ["time", "endTime"] as const) {
    if (body[key] === undefined) continue;
    if (body[key] === null || body[key] === "") {
      out[key] = null;
      continue;
    }
    if (typeof body[key] !== "string" || !TIME_RE.test(body[key] as string)) {
      return { error: `${key} must be HH:MM (24h)` };
    }
    out[key] = body[key] as string;
  }
  if (body.location !== undefined) {
    out.location =
      typeof body.location === "string" && body.location.trim()
        ? body.location.trim().slice(0, MAX_LOCATION)
        : null;
  }
  if (body.category !== undefined) {
    const c = typeof body.category === "string" ? body.category.trim().toLowerCase() : "";
    out.category = CATEGORIES.has(c) ? c : null;
  }
  if (body.notes !== undefined) {
    out.notes =
      typeof body.notes === "string" && body.notes.trim() ? body.notes.trim().slice(0, MAX_NOTES) : null;
  }
  return { fields: out };
}

/** Mounted as `app.route("/api/calendar", calendarRoutes(...))` BEFORE the
    /api/* session gate — it owns its own two-plane auth, like the Library. */
export function calendarRoutes(
  resolveSession: (
    env: Env,
    req: Request,
  ) => Promise<{ tenantId: string; userId: string; userHandle: string; deviceLabel: string; role: Role } | null>,
) {
  const cal = new Hono<{ Bindings: Env; Variables: Vars }>();

  cal.use("*", async (c, next) => {
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
    if (s.role === "guest") return c.json({ error: "the guest account has no calendar" }, 403);
    c.set("actor", { kind: "session", ...s });
    return next();
  });

  // ---- range read (both planes) -------------------------------------------
  cal.get("/", async (c) => {
    const actor = c.get("actor");
    const from = c.req.query("from") ?? "";
    const to = c.req.query("to") ?? "";
    if (!validDate(from) || !validDate(to)) {
      return c.json({ error: "from and to (YYYY-MM-DD) are required" }, 400);
    }
    if (to < from) return c.json({ error: "to is before from" }, 400);
    const spanDays = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (spanDays > MAX_RANGE_DAYS) return c.json({ error: `range too wide (max ${MAX_RANGE_DAYS} days)` }, 400);
    const rows = await c.env.DB.prepare(
      `SELECT ${EVENT_COLS} FROM calendar_events
        WHERE tenant_id = ? AND date >= ? AND date <= ?
        ORDER BY date, time IS NOT NULL, time, title`,
    )
      .bind(actor.tenantId, from, to)
      .all<EventRow>();
    return c.json({ events: rows.results });
  });

  // ---- create (service plane only, this era) -------------------------------
  cal.post("/", async (c) => {
    const actor = c.get("actor");
    if (actor.kind !== "service") {
      return c.json({ error: "events are written by the Computer — service token only (for now)" }, 403);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const cleaned = cleanFields(body, false);
    if ("error" in cleaned) return c.json({ error: cleaned.error }, 400);
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE tenant_id = ?")
      .bind(actor.tenantId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_EVENTS_PER_TENANT) {
      return c.json({ error: `calendar is full (${MAX_EVENTS_PER_TENANT} events)` }, 409);
    }
    const createdBy =
      typeof body.createdBy === "string" && body.createdBy.trim()
        ? body.createdBy.trim().toLowerCase().slice(0, 40)
        : "computer";
    const id = `ev_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const f = cleaned.fields;
    await c.env.DB.prepare(
      `INSERT INTO calendar_events (id, tenant_id, title, date, time, end_time, location, category, notes, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        actor.tenantId,
        f.title,
        f.date,
        f.time ?? null,
        f.endTime ?? null,
        f.location ?? null,
        f.category ?? null,
        f.notes ?? null,
        createdBy,
        now,
        now,
      )
      .run();
    const row = await c.env.DB.prepare(`SELECT ${EVENT_COLS} FROM calendar_events WHERE id = ?`)
      .bind(id)
      .first<EventRow>();
    return c.json({ event: row }, 201);
  });

  // ---- update (service plane only, this era) -------------------------------
  cal.post("/:id", async (c) => {
    const actor = c.get("actor");
    if (actor.kind !== "service") {
      return c.json({ error: "events are written by the Computer — service token only (for now)" }, 403);
    }
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const cleaned = cleanFields(body, true);
    if ("error" in cleaned) return c.json({ error: cleaned.error }, 400);
    const sets = Object.keys(cleaned.fields);
    if (!sets.length) return c.json({ error: "nothing to update" }, 400);
    const colFor: Record<string, string> = {
      title: "title",
      date: "date",
      time: "time",
      endTime: "end_time",
      location: "location",
      category: "category",
      notes: "notes",
    };
    const assignments = sets.map((k) => `${colFor[k]} = ?`).join(", ");
    const values = sets.map((k) => cleaned.fields[k]);
    const res = await c.env.DB.prepare(
      `UPDATE calendar_events SET ${assignments}, updated_at = ? WHERE tenant_id = ? AND id = ?`,
    )
      .bind(...values, Date.now(), actor.tenantId, c.req.param("id"))
      .run();
    if (!res.meta.changes) return c.json({ error: "no such event" }, 404);
    const row = await c.env.DB.prepare(`SELECT ${EVENT_COLS} FROM calendar_events WHERE id = ?`)
      .bind(c.req.param("id"))
      .first<EventRow>();
    return c.json({ event: row });
  });

  // ---- delete (service plane only, this era) -------------------------------
  cal.delete("/:id", async (c) => {
    const actor = c.get("actor");
    if (actor.kind !== "service") {
      return c.json({ error: "events are written by the Computer — service token only (for now)" }, 403);
    }
    const res = await c.env.DB.prepare("DELETE FROM calendar_events WHERE tenant_id = ? AND id = ?")
      .bind(actor.tenantId, c.req.param("id"))
      .run();
    if (!res.meta.changes) return c.json({ error: "no such event" }, 404);
    return c.json({ ok: true });
  });

  return cal;
}
