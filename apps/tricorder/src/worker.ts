/**
 * Tricorder Worker (TNGC-14/15) — the public face at myhome.computer
 * (tricorder.lalalimited.com remains a live legacy alias).
 *
 * Auth model: this API is on the open internet, so everything is gated.
 *  - people authenticate with handle+password → session token (POST /api/login);
 *    a session is a user on a device *label* — users are the identity anchor,
 *    the same user can hold any number of concurrent sessions
 *  - the home bridge authenticates with the tenant service token → GET /link (WSS)
 * Tokens are stored hashed (SHA-256) in D1, passwords as PBKDF2. The queue
 * itself lives in the per-tenant TenantHub Durable Object. Static assets under
 * ./public (the PWA) are served by the platform before this Worker runs.
 */
import { Hono } from "hono";
import { CONTRACT_VERSION, type TngMessage } from "@tng/contract";
import type { Env } from "./hub";
import { guestPassword, hashPassword, randomToken, sha256Hex, verifyPassword } from "./auth";
import { libraryRoutes } from "./library";
import { mintPairCode, registerRoutes } from "./register";

export { TenantHub } from "./hub";

const MAX_TRANSCRIPT_CHARS = 2000;
const MAX_FAILED_LOGINS = 5;
const LOGIN_COOLDOWN_MS = 5 * 60_000;
const GUEST_SESSION_TTL_MS = 24 * 60 * 60_000;
const MAX_DEVICE_LABEL_CHARS = 40;
const MAX_USERS_PER_TENANT = 8;

const ROLES = ["admin", "member", "guest"] as const;
type Role = (typeof ROLES)[number];

interface SessionIdentity {
  tenantId: string;
  sessionId: string;
  userId: string;
  userHandle: string;
  userName: string;
  role: Role;
  deviceLabel: string;
}

type Vars = { session: SessionIdentity };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const hub = (c: { env: Env }, tenantId: string) =>
  c.env.TENANT_HUB.get(c.env.TENANT_HUB.idFromName(tenantId));

app.get("/health", (c) =>
  c.json({ ok: true, service: "tricorder", contract: CONTRACT_VERSION, runtime: "cloudflare-worker" }),
);

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return null;
}

// ---- bridge link (service token) --------------------------------------------

app.get("/link", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "websocket upgrade required" }, 426);
  }
  // The bridge sends the token as a header (ws client supports it); a query
  // param is accepted as fallback for clients that can't set headers.
  const token = bearerToken(c.req.raw) ?? c.req.query("token") ?? "";
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const hash = await sha256Hex(token);
  const tenant = await c.env.DB.prepare("SELECT id FROM tenants WHERE service_token_hash = ?")
    .bind(hash)
    .first<{ id: string }>();
  if (!tenant) return c.json({ error: "unauthorized" }, 401);
  return hub(c, tenant.id).fetch(new Request("https://hub/link", c.req.raw));
});

// ---- self-serve tenancy (TNGC-29): register / verify / pair — all public,
// all throttled, mounted before the session gate like /api/login -------------

app.route("/api", registerRoutes());

// ---- login (public — registered before the session gate) ---------------------

interface LoginRow {
  id: string;
  tenantId: string;
  handle: string;
  name: string;
  role: Role;
  disabled: number;
  passwordHash: string | null;
  failedAttempts: number;
  lockedUntil: number | null;
  email: string | null;
  emailVerifiedAt: number | null;
}

const LOGIN_COLS = `u.id, u.tenant_id AS tenantId, u.handle, u.name, u.role, u.disabled,
       u.password_hash AS passwordHash, u.failed_attempts AS failedAttempts,
       u.locked_until AS lockedUntil, u.email, u.email_verified_at AS emailVerifiedAt`;

app.post("/api/login", async (c) => {
  let body: { handle?: unknown; password?: unknown; deviceLabel?: unknown; household?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.handle !== "string" || typeof body.password !== "string") {
    return c.json({ error: "handle and password are required" }, 400);
  }
  const deviceLabel =
    (typeof body.deviceLabel === "string" ? body.deviceLabel.trim().slice(0, MAX_DEVICE_LABEL_CHARS) : "") ||
    "unknown device";

  // Multi-tenant resolution (TNGC-29): a household slug scopes the handle; an
  // email is globally unique on its own; a bare handle works while it is
  // unambiguous (one match across all tenants) — the moment two households
  // share "mom", the PWA asks for the household name. The uniform 401 below
  // never reveals whether the identity exists, has no password, or is disabled.
  const identifier = body.handle.trim().toLowerCase();
  const household = typeof body.household === "string" ? body.household.trim().toLowerCase() : "";
  let user: LoginRow | null | undefined;
  if (household) {
    user = await c.env.DB.prepare(
      `SELECT ${LOGIN_COLS} FROM users u JOIN tenants t ON t.id = u.tenant_id
        WHERE t.slug = ? AND u.handle = ?`,
    )
      .bind(household, identifier)
      .first<LoginRow>();
  } else if (identifier.includes("@")) {
    user = await c.env.DB.prepare(`SELECT ${LOGIN_COLS} FROM users u WHERE u.email = ?`)
      .bind(identifier)
      .first<LoginRow>();
  } else {
    const rows = await c.env.DB.prepare(`SELECT ${LOGIN_COLS} FROM users u WHERE u.handle = ? LIMIT 2`)
      .bind(identifier)
      .all<LoginRow>();
    if (rows.results.length > 1) {
      return c.json(
        { error: "that handle exists in more than one household — add your household name", needHousehold: true },
        400,
      );
    }
    user = rows.results[0];
  }

  if (!user || user.disabled || !user.passwordHash) {
    return c.json({ error: "invalid credentials" }, 401);
  }
  const now = Date.now();
  if (user.lockedUntil && user.lockedUntil > now) {
    return c.json({ error: "too many attempts — try again later", retryAfterMs: user.lockedUntil - now }, 429);
  }

  if (!(await verifyPassword(body.password, user.passwordHash))) {
    const failed = user.failedAttempts + 1;
    const lockedUntil = failed >= MAX_FAILED_LOGINS ? now + LOGIN_COOLDOWN_MS : null;
    await c.env.DB.prepare("UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?")
      .bind(failed, lockedUntil, user.id)
      .run();
    if (lockedUntil) {
      return c.json({ error: "too many attempts — try again later", retryAfterMs: LOGIN_COOLDOWN_MS }, 429);
    }
    return c.json({ error: "invalid credentials" }, 401);
  }

  // Self-registered admins must verify their email before first login;
  // console-created household members have no email and are never gated.
  if (user.email && !user.emailVerifiedAt) {
    return c.json({ error: "verify your email first — check your inbox", unverified: true }, 403);
  }

  const token = randomToken();
  const expiresAt = user.role === "guest" ? now + GUEST_SESSION_TTL_MS : null;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?").bind(user.id),
    c.env.DB.prepare(
      `INSERT INTO sessions (id, tenant_id, user_id, device_label, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(`s_${crypto.randomUUID()}`, user.tenantId, user.id, deviceLabel, await sha256Hex(token), now, expiresAt),
  ]);
  return c.json({
    token,
    user: { handle: user.handle, name: user.name, role: user.role },
    deviceLabel,
    expiresAt,
  });
});

// ---- session resolution (shared by the /api/* gate and the library plane) ----

async function lookupSession(env: Env, req: Request): Promise<SessionIdentity | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.id AS sessionId, s.tenant_id AS tenantId, s.user_id AS userId, s.device_label AS deviceLabel,
            s.expires_at AS expiresAt, u.handle AS userHandle, u.name AS userName, u.role, u.disabled
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(hash)
    .first<SessionIdentity & { expiresAt: number | null; disabled: number }>();
  if (!row || row.disabled) return null;
  if (row.expiresAt && row.expiresAt <= Date.now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(row.sessionId).run();
    return null;
  }
  return row;
}

// ---- the library (TNGC-23) — registered BEFORE the session gate because it
// speaks two auth planes (service token OR session); see library.ts ----------

app.route("/api/library", libraryRoutes(lookupSession, hub));

// ---- session gate for everything else under /api/ ----------------------------

app.use("/api/*", async (c, next) => {
  const row = await lookupSession(c.env, c.req.raw);
  if (!row) return c.json({ error: "unauthorized" }, 401);
  c.set("session", row);
  c.executionCtx.waitUntil(
    c.env.DB.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").bind(Date.now(), row.sessionId).run(),
  );
  await next();
});

app.get("/api/me", (c) => {
  const s = c.get("session");
  return c.json({
    user: { handle: s.userHandle, name: s.userName, role: s.role },
    deviceLabel: s.deviceLabel,
  });
});

// Household members for the Library's send picker (TNGC-23): everyone who can
// receive — no guests, no disabled users, not yourself. Deliberately thin
// (handle + name only); the admin overview stays admin-gated.
app.get("/api/users", async (c) => {
  const s = c.get("session");
  if (s.role === "guest") return c.json({ error: "the guest account has no library" }, 403);
  const rows = await c.env.DB.prepare(
    `SELECT handle, name FROM users
      WHERE tenant_id = ? AND role != 'guest' AND disabled = 0 AND id != ?
      ORDER BY name`,
  )
    .bind(s.tenantId, s.userId)
    .all<{ handle: string; name: string }>();
  return c.json({ users: rows.results });
});

app.post("/api/logout", async (c) => {
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(c.get("session").sessionId).run();
  return c.json({ ok: true });
});

// ---- the microphone -----------------------------------------------------------

app.post("/api/message", async (c) => {
  let body: { transcript?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.transcript !== "string" || body.transcript.trim() === "") {
    return c.json({ error: "transcript (non-empty string) is required" }, 400);
  }
  if (body.transcript.length > MAX_TRANSCRIPT_CHARS) {
    return c.json({ error: `transcript too long (max ${MAX_TRANSCRIPT_CHARS} chars)` }, 400);
  }

  const s = c.get("session");
  const msg: TngMessage = {
    user: s.userHandle,
    device: s.deviceLabel,
    transcript: body.transcript.trim(),
    ts: Date.now(),
  };
  const res = await hub(c, s.tenantId).fetch(
    new Request("https://hub/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg),
    }),
  );
  return new Response(res.body, { status: res.status === 200 ? 202 : res.status, headers: res.headers });
});

app.get("/api/status", async (c) => {
  return hub(c, c.get("session").tenantId).fetch(new Request("https://hub/status"));
});

// ---- the command queue (TNGC-22) ------------------------------------------------

app.get("/api/queue", async (c) => {
  const s = c.get("session");
  const res = await hub(c, s.tenantId).fetch(new Request("https://hub/queue"));
  const data = (await res.json()) as { online: boolean; items: Array<{ user: string }> };
  return c.json({
    online: data.online,
    role: s.role,
    items: data.items.map((item) => ({ ...item, mine: item.user === s.userHandle })),
  });
});

// Withdraw a queued command / cancel the active one. Own commands only —
// unless you hold the admin role, which can clear anyone's.
app.post("/api/queue/:id/withdraw", async (c) => {
  const s = c.get("session");
  const id = c.req.param("id");
  const h = hub(c, s.tenantId);
  const snap = (await (await h.fetch(new Request("https://hub/queue"))).json()) as {
    items: Array<{ id: string; user: string }>;
  };
  const item = snap.items.find((i) => i.id === id);
  if (!item) return c.json({ error: "no such command (already finished?)" }, 404);
  if (item.user !== s.userHandle && s.role !== "admin") {
    return c.json({ error: "you can only withdraw your own commands" }, 403);
  }
  const res = await h.fetch(
    new Request("https://hub/withdraw", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, by: s.userHandle }),
    }),
  );
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// ---- admin console (admin-role sessions only) ----------------------------------

app.use("/api/admin/*", async (c, next) => {
  if (c.get("session").role !== "admin") return c.json({ error: "admin only" }, 403);
  await next();
});

app.get("/api/admin/overview", async (c) => {
  const tenantId = c.get("session").tenantId;
  const [users, sessions] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, handle, name, role, disabled, password_hash IS NOT NULL AS hasPassword
         FROM users WHERE tenant_id = ? ORDER BY created_at`,
    )
      .bind(tenantId)
      .all<{ id: string; handle: string; name: string; role: Role; disabled: number; hasPassword: number }>(),
    c.env.DB.prepare(
      `SELECT id, user_id AS userId, device_label AS deviceLabel, created_at AS createdAt,
              last_seen_at AS lastSeenAt, expires_at AS expiresAt
         FROM sessions WHERE tenant_id = ? ORDER BY created_at DESC`,
    )
      .bind(tenantId)
      .all<{ id: string; userId: string; deviceLabel: string; createdAt: number; lastSeenAt: number | null; expiresAt: number | null }>(),
  ]);
  const now = Date.now();
  return c.json({
    users: users.results.map((u) => ({
      ...u,
      disabled: !!u.disabled,
      hasPassword: !!u.hasPassword,
      sessions: sessions.results
        .filter((s) => s.userId === u.id && (!s.expiresAt || s.expiresAt > now))
        .map(({ userId: _drop, ...s }) => s),
    })),
  });
});

app.post("/api/admin/users", async (c) => {
  let body: { handle?: unknown; name?: unknown; role?: unknown; password?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const handle = typeof body.handle === "string" ? body.handle.trim().toLowerCase() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const role = body.role as Role;
  if (!/^[a-z0-9_-]{2,20}$/.test(handle)) {
    return c.json({ error: "handle must be 2-20 chars: a-z 0-9 _ -" }, 400);
  }
  if (!name) return c.json({ error: "name is required" }, 400);
  if (!ROLES.includes(role)) return c.json({ error: `role must be one of: ${ROLES.join(", ")}` }, 400);
  if (typeof body.password !== "string" || body.password.length < 6) {
    return c.json({ error: "password must be at least 6 characters" }, 400);
  }
  const tenantId = c.get("session").tenantId;
  const dupe = await c.env.DB.prepare("SELECT id FROM users WHERE tenant_id = ? AND handle = ?")
    .bind(tenantId, handle)
    .first();
  if (dupe) return c.json({ error: `handle "${handle}" is taken` }, 409);
  // Household cap (TNGC-29): the guest identity doesn't count against it.
  if (role !== "guest") {
    const n = await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role != 'guest'",
    )
      .bind(tenantId)
      .first<{ n: number }>();
    if ((n?.n ?? 0) >= MAX_USERS_PER_TENANT) {
      return c.json({ error: `household is full (${MAX_USERS_PER_TENANT} members max)` }, 409);
    }
  }
  const id = `u_${crypto.randomUUID().slice(0, 8)}`;
  await c.env.DB.prepare(
    "INSERT INTO users (id, tenant_id, handle, name, created_at, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, tenantId, handle, name, Date.now(), await hashPassword(body.password), role)
    .run();
  return c.json({ user: { id, handle, name, role } }, 201);
});

/** Look up a target user within the caller's tenant, or null. */
async function tenantUser(c: { env: Env }, tenantId: string, userId: string) {
  return c.env.DB.prepare("SELECT id, handle, role FROM users WHERE tenant_id = ? AND id = ?")
    .bind(tenantId, userId)
    .first<{ id: string; handle: string; role: Role }>();
}

// Setting a password revokes every session that user holds — atomically (D1
// batch = one transaction). Closes the remembered-password hole and the
// lingering-token hole in the same stroke.
app.post("/api/admin/users/:id/password", async (c) => {
  let body: { password?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.password !== "string" || body.password.length < 6) {
    return c.json({ error: "password must be at least 6 characters" }, 400);
  }
  const s = c.get("session");
  const target = await tenantUser(c, s.tenantId, c.req.param("id"));
  if (!target) return c.json({ error: "no such user" }, 404);
  const [, revoke] = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?",
    ).bind(await hashPassword(body.password), target.id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id),
  ]);
  return c.json({ ok: true, revokedSessions: revoke.meta.changes ?? 0 });
});

app.post("/api/admin/users/:id/disabled", async (c) => {
  let body: { disabled?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.disabled !== "boolean") return c.json({ error: "disabled (boolean) is required" }, 400);
  const s = c.get("session");
  const target = await tenantUser(c, s.tenantId, c.req.param("id"));
  if (!target) return c.json({ error: "no such user" }, 404);
  if (target.id === s.userId) return c.json({ error: "cannot disable yourself" }, 400);
  const statements = [
    c.env.DB.prepare("UPDATE users SET disabled = ? WHERE id = ?").bind(body.disabled ? 1 : 0, target.id),
  ];
  if (body.disabled) statements.push(c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(target.id));
  await c.env.DB.batch(statements);
  return c.json({ ok: true, disabled: body.disabled });
});

app.delete("/api/admin/sessions/:id", async (c) => {
  const s = c.get("session");
  const res = await c.env.DB.prepare("DELETE FROM sessions WHERE tenant_id = ? AND id = ?")
    .bind(s.tenantId, c.req.param("id"))
    .run();
  if (!res.meta.changes) return c.json({ error: "no such session" }, 404);
  return c.json({ ok: true });
});

// Pair your Computer (TNGC-29): mint the single-use code the house wizard
// trades for the service token. One live code per tenant; 15-minute TTL;
// shown to the admin exactly once.
app.post("/api/admin/pair-code", async (c) => {
  const s = c.get("session");
  const { code, expiresAt } = await mintPairCode(c.env, s.tenantId, s.userId);
  // Human-friendly display grouping; /api/pair strips separators anyway.
  return c.json({ code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt });
});

// One tap at the door when the party ends: fresh word-pair password (shown to
// the admin exactly once — it is never retrievable later) + every guest
// session revoked, atomically.
app.post("/api/admin/rotate-guest", async (c) => {
  const s = c.get("session");
  const guest = await c.env.DB.prepare("SELECT id FROM users WHERE tenant_id = ? AND role = 'guest'")
    .bind(s.tenantId)
    .first<{ id: string }>();
  if (!guest) return c.json({ error: "no guest-role user exists" }, 404);
  const password = guestPassword();
  const [, revoke] = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL, disabled = 0 WHERE id = ?",
    ).bind(await hashPassword(password), guest.id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(guest.id),
  ]);
  return c.json({ password, revokedSessions: revoke.meta.changes ?? 0 });
});

export default app;
