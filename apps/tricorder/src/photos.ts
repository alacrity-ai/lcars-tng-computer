/**
 * Family photos API (TNGC-64) — D1 index + R2 objects, the Library's shape
 * applied to binary media.
 *
 * Auth is three-plane here, one more than calendar/lists:
 *  - service (tenant token) — read the index (the Computer's `photos` tool
 *    and the bridge's idle gallery). Uploads are human acts: session only.
 *  - session (PWA bearer, admin/member) — upload, browse, delete own
 *    (admin deletes any). Guests are bounced.
 *  - capability — GET /raw/<id>/<secret> serves bytes with NO auth header:
 *    walls and phones consume photos as plain <img src>. The secret is 16
 *    random bytes per photo; deletion revokes it. Immutable + long cache.
 *
 * Uploads arrive as raw resized JPEG/WebP bytes (the PWA downsizes on the
 * phone before sending); originals are out of scope by design.
 */
import { Hono } from "hono";
import type { Env } from "./hub";
import { sha256Hex } from "./auth";

type Role = "admin" | "member" | "guest";

type Actor =
  | { kind: "service"; tenantId: string }
  | { kind: "session"; tenantId: string; userId: string; userHandle: string; deviceLabel: string; role: Role };

type Vars = { actor: Actor };

const MAX_PHOTO_BYTES = 4 * 1024 * 1024; // post-resize; the PWA targets well under this
const MAX_PHOTOS_PER_TENANT = 1000;
const MAX_ALBUM_CHARS = 40;
const CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

interface PhotoRow {
  id: string;
  secret: string;
  album: string | null;
  takenAt: number;
  width: number | null;
  height: number | null;
  bytes: number;
  contentType: string;
  createdBy: string;
  createdAt: number;
}

const COLS =
  "id, secret, album, taken_at AS takenAt, width, height, bytes, content_type AS contentType, created_by AS createdBy, created_at AS createdAt";

const r2Key = (tenantId: string, id: string) => `photos/${tenantId}/${id}`;

function publicPhoto(row: PhotoRow, origin: string) {
  return {
    id: row.id,
    url: `${origin}/api/photos/raw/${row.id}/${row.secret}`,
    album: row.album,
    takenAt: row.takenAt,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    createdBy: row.createdBy,
  };
}

function cleanAlbum(raw: unknown): string | null {
  const a = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ").slice(0, MAX_ALBUM_CHARS) : "";
  return a || null;
}

export function photosRoutes(
  resolveSession: (
    env: Env,
    req: Request,
  ) => Promise<{ tenantId: string; userId: string; userHandle: string; deviceLabel: string; role: Role } | null>,
) {
  const ph = new Hono<{ Bindings: Env; Variables: Vars }>();

  // ---- capability plane: raw bytes, no bearer — mounted BEFORE the auth
  // middleware so <img> tags work everywhere. The 32-hex secret IS the auth.
  ph.get("/raw/:id/:secret", async (c) => {
    const id = c.req.param("id");
    const secret = c.req.param("secret");
    if (!/^ph_[a-f0-9-]{1,20}$/.test(id) || !/^[a-f0-9]{32}$/.test(secret)) {
      return c.json({ error: "not found" }, 404);
    }
    const row = await c.env.DB.prepare(
      "SELECT tenant_id AS tenantId, secret, content_type AS contentType FROM photos WHERE id = ?",
    )
      .bind(id)
      .first<{ tenantId: string; secret: string; contentType: string }>();
    if (!row || row.secret !== secret) return c.json({ error: "not found" }, 404);
    const obj = await c.env.LIBRARY.get(r2Key(row.tenantId, id));
    if (!obj) return c.json({ error: "not found" }, 404);
    return new Response(obj.body, {
      headers: {
        "content-type": row.contentType,
        // The URL is unique per photo and dies with it — cache hard.
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });

  ph.use("*", async (c, next) => {
    // The capability plane stays bearer-free (Hono runs `use` middleware for
    // routes registered before it too — the exemption must be explicit).
    if (c.req.path.includes("/raw/")) return next();
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
    if (s.role === "guest") return c.json({ error: "the guest account has no photos" }, 403);
    c.set("actor", { kind: "session", ...s });
    return next();
  });

  // ---- index: newest first, optional album/month filters ------------------
  ph.get("/", async (c) => {
    const actor = c.get("actor");
    const origin = new URL(c.req.url).origin;
    const album = cleanAlbum(c.req.query("album"));
    const month = c.req.query("month"); // YYYY-MM
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 500);
    const where: string[] = ["tenant_id = ?"];
    const binds: unknown[] = [actor.tenantId];
    if (album) {
      where.push("album = ?");
      binds.push(album);
    }
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split("-").map(Number);
      where.push("taken_at >= ? AND taken_at < ?");
      binds.push(Date.UTC(y, m - 1, 1), Date.UTC(m === 12 ? y + 1 : y, m % 12, 1));
    }
    const rows = await c.env.DB.prepare(
      `SELECT ${COLS} FROM photos WHERE ${where.join(" AND ")} ORDER BY taken_at DESC, id LIMIT ?`,
    )
      .bind(...binds, limit)
      .all<PhotoRow>();
    const albums = await c.env.DB.prepare(
      "SELECT album, COUNT(*) AS n FROM photos WHERE tenant_id = ? AND album IS NOT NULL GROUP BY album ORDER BY album",
    )
      .bind(actor.tenantId)
      .all<{ album: string; n: number }>();
    const total = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM photos WHERE tenant_id = ?")
      .bind(actor.tenantId)
      .first<{ n: number }>();
    return c.json({
      photos: rows.results.map((r) => publicPhoto(r, origin)),
      albums: albums.results,
      total: total?.n ?? 0,
    });
  });

  // ---- upload (session plane only — an upload is a human act) --------------
  ph.post("/", async (c) => {
    const actor = c.get("actor");
    if (actor.kind !== "session") {
      return c.json({ error: "uploads come from people — use a tricorder session" }, 403);
    }
    const contentType = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!CONTENT_TYPES.has(contentType)) {
      return c.json({ error: "content-type must be image/jpeg, image/png, or image/webp" }, 400);
    }
    const body = await c.req.arrayBuffer();
    if (body.byteLength === 0) return c.json({ error: "empty body" }, 400);
    if (body.byteLength > MAX_PHOTO_BYTES) {
      return c.json({ error: `photo too large (max ${MAX_PHOTO_BYTES / 1024 / 1024}MB — resize before upload)` }, 413);
    }
    const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM photos WHERE tenant_id = ?")
      .bind(actor.tenantId)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_PHOTOS_PER_TENANT) {
      return c.json({ error: `photo library is full (${MAX_PHOTOS_PER_TENANT})` }, 409);
    }
    const takenAtRaw = Number(c.req.header("x-photo-taken-at"));
    const takenAt =
      Number.isFinite(takenAtRaw) && takenAtRaw > 946_684_800_000 && takenAtRaw < Date.now() + 86_400_000
        ? Math.round(takenAtRaw)
        : Date.now();
    const width = Number(c.req.header("x-photo-width")) || null;
    const height = Number(c.req.header("x-photo-height")) || null;
    const album = cleanAlbum(c.req.header("x-photo-album") ? decodeURIComponent(c.req.header("x-photo-album")!) : "");
    const id = `ph_${crypto.randomUUID().slice(0, 12)}`;
    const secret = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await c.env.LIBRARY.put(r2Key(actor.tenantId, id), body, {
      httpMetadata: { contentType },
    });
    await c.env.DB.prepare(
      `INSERT INTO photos (id, tenant_id, secret, album, taken_at, width, height, bytes, content_type, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        actor.tenantId,
        secret,
        album,
        takenAt,
        width,
        height,
        body.byteLength,
        contentType,
        actor.userHandle.slice(0, 40),
        Date.now(),
      )
      .run();
    const row = await c.env.DB.prepare(`SELECT ${COLS} FROM photos WHERE id = ?`).bind(id).first<PhotoRow>();
    return c.json({ photo: publicPhoto(row!, new URL(c.req.url).origin) }, 201);
  });

  // ---- delete: your own, or any as admin; R2 object goes with it ----------
  ph.delete("/:id", async (c) => {
    const actor = c.get("actor");
    if (actor.kind !== "session") return c.json({ error: "session required" }, 403);
    const row = await c.env.DB.prepare(
      `SELECT ${COLS} FROM photos WHERE tenant_id = ? AND id = ?`,
    )
      .bind(actor.tenantId, c.req.param("id"))
      .first<PhotoRow>();
    if (!row) return c.json({ error: "no such photo" }, 404);
    if (actor.role !== "admin" && row.createdBy !== actor.userHandle) {
      return c.json({ error: "you can only delete your own photos" }, 403);
    }
    await c.env.DB.prepare("DELETE FROM photos WHERE tenant_id = ? AND id = ?")
      .bind(actor.tenantId, row.id)
      .run();
    await c.env.LIBRARY.delete(r2Key(actor.tenantId, row.id));
    return c.json({ ok: true });
  });

  return ph;
}
