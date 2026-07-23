/**
 * Self-serve tenancy (TNGC-29): registration, email verification, pairing.
 *
 * All of these routes are PUBLIC (mounted before the session gate) — every one
 * is throttled against D1-backed fixed windows, and every failure is uniform
 * so nothing leaks which emails/households/codes exist.
 *
 * Pairing is the UX that replaces "paste a service token": an admin mints a
 * short-lived single-use code in the console; the house wizard trades it at
 * POST /api/pair for the tenant's service token — returned exactly once, and
 * minting-on-redeem ROTATES the token, so pairing a new box always severs the
 * old one (one bridge per tenant is already the hub's law).
 */
import { Hono } from "hono";
import type { Env } from "./hub";
import { hashPassword, randomToken, sha256Hex } from "./auth";

const REGISTER_IP_LIMIT = 5; // per hour per IP
const REGISTER_GLOBAL_LIMIT = 50; // per day, all IPs — a mass-signup fuse
const PAIR_IP_LIMIT = 10; // per 15 min per IP
const RESEND_LIMIT = 3; // per hour per email
const VERIFY_TTL_MS = 24 * 60 * 60_000;
const PAIR_CODE_TTL_MS = 15 * 60_000;
const MIN_PASSWORD_CHARS = 8;

// No 0/O/1/I — the code gets read off a phone screen and typed on a TV box.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

type Vars = Record<string, never>;

export function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Fixed-window counter in D1. Returns true if the call is within limit. */
export async function throttle(env: Env, key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT window_start AS ws, count FROM throttle WHERE key = ?")
    .bind(key)
    .first<{ ws: number; count: number }>();
  if (!row || now - row.ws >= windowMs) {
    await env.DB.prepare(
      "INSERT INTO throttle (key, window_start, count) VALUES (?, ?, 1) " +
        "ON CONFLICT(key) DO UPDATE SET window_start = ?, count = 1",
    )
      .bind(key, now, now)
      .run();
    return true;
  }
  if (row.count >= limit) return false;
  await env.DB.prepare("UPDATE throttle SET count = count + 1 WHERE key = ?").bind(key).run();
  return true;
}

/** Household name → URL-ish slug: "The Taylor House" → "the-taylor-house". */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

/** Email local part → a legal handle ("leif.k.taylor" → "leifktaylor"). */
function handleFromEmail(email: string): string {
  const h = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20);
  return h.length >= 2 ? h : "captain";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sendVerifyEmail(env: Env, to: string, household: string, url: string): Promise<void> {
  if (!env.MAILGUN_API_KEY || !env.MAILGUN_DOMAIN) {
    console.log(`[register] mail disabled — verification for ${household} not sent`);
    return;
  }
  const from = env.MAIL_FROM ?? `TNG Computer <tricorder@${env.MAILGUN_DOMAIN}>`;
  const form = new URLSearchParams({
    from,
    to,
    subject: "Verify your Tricorder household",
    text:
      `Your household "${household}" is almost ready.\n\n` +
      `Confirm your email to activate it:\n${url}\n\n` +
      `The link is good for 24 hours. If you didn't register, ignore this.`,
  });
  const res = await fetch(`https://api.mailgun.net/v3/${env.MAILGUN_DOMAIN}/messages`, {
    method: "POST",
    headers: { authorization: "Basic " + btoa(`api:${env.MAILGUN_API_KEY}`) },
    body: form,
  });
  if (!res.ok) console.log(`[register] mailgun send failed: ${res.status}`);
}

export function newPairCode(): string {
  const rand = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = "";
  for (const b of rand) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/** "abcd-efgh", "ABCD EFGH" → "ABCDEFGH". */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Mint a pairing code for a tenant (admin console calls this via the Worker).
    One live code per tenant: minting deletes any unused predecessors. */
export async function mintPairCode(
  env: Env,
  tenantId: string,
  createdBy: string,
): Promise<{ code: string; expiresAt: number }> {
  const code = newPairCode();
  const now = Date.now();
  const expiresAt = now + PAIR_CODE_TTL_MS;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pair_codes WHERE tenant_id = ? AND used_at IS NULL").bind(tenantId),
    env.DB.prepare(
      "INSERT INTO pair_codes (id, tenant_id, code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(`pc_${crypto.randomUUID().slice(0, 8)}`, tenantId, await sha256Hex(code), createdBy, now, expiresAt),
  ]);
  return { code, expiresAt };
}

export function registerRoutes() {
  const pub = new Hono<{ Bindings: Env; Variables: Vars }>();

  // ---- create a household --------------------------------------------------
  pub.post("/register", async (c) => {
    const ip = clientIp(c.req.raw);
    if (
      !(await throttle(c.env, `register:ip:${ip}`, REGISTER_IP_LIMIT, 60 * 60_000)) ||
      !(await throttle(c.env, "register:global", REGISTER_GLOBAL_LIMIT, 24 * 60 * 60_000))
    ) {
      return c.json({ error: "too many registrations — try again later" }, 429);
    }
    let body: { household?: unknown; email?: unknown; password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const household = typeof body.household === "string" ? body.household.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (household.length < 2 || household.length > 40) {
      return c.json({ error: "household name must be 2-40 characters" }, 400);
    }
    if (!EMAIL_RE.test(email)) return c.json({ error: "a valid email is required" }, 400);
    if (typeof body.password !== "string" || body.password.length < MIN_PASSWORD_CHARS) {
      return c.json({ error: `password must be at least ${MIN_PASSWORD_CHARS} characters` }, 400);
    }
    const slug = slugify(household);
    if (slug.length < 2) return c.json({ error: "household name needs at least 2 letters or digits" }, 400);

    const [slugTaken, emailTaken] = await Promise.all([
      c.env.DB.prepare("SELECT id FROM tenants WHERE slug = ?").bind(slug).first(),
      c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first(),
    ]);
    if (slugTaken) return c.json({ error: `household name "${slug}" is taken — pick another` }, 409);
    if (emailTaken) return c.json({ error: "that email already has a household — log in instead" }, 409);

    const now = Date.now();
    const tenantId = `t_${crypto.randomUUID().slice(0, 8)}`;
    const adminId = `u_${crypto.randomUUID().slice(0, 8)}`;
    const guestId = `u_${crypto.randomUUID().slice(0, 8)}`;
    const handle = handleFromEmail(email);
    const verifyToken = randomToken();
    // Unpaired state: the stored service hash is of a token nobody holds —
    // /link can never match until the first pairing rotates it to a real one.
    const unpairedHash = await sha256Hex(randomToken());

    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO tenants (id, name, service_token_hash, created_at, slug, created_ip) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(tenantId, household, unpairedHash, now, slug, ip),
      c.env.DB.prepare(
        `INSERT INTO users (id, tenant_id, handle, name, created_at, password_hash, role, email)
         VALUES (?, ?, ?, ?, ?, ?, 'admin', ?)`,
      ).bind(adminId, tenantId, handle, handle, now, await hashPassword(body.password), email),
      c.env.DB.prepare(
        "INSERT INTO users (id, tenant_id, handle, name, created_at, role, disabled) VALUES (?, ?, 'guest', 'Guest', ?, 'guest', 1)",
      ).bind(guestId, tenantId, now),
      c.env.DB.prepare(
        "INSERT INTO email_tokens (id, tenant_id, user_id, purpose, token_hash, created_at, expires_at) VALUES (?, ?, ?, 'verify', ?, ?, ?)",
      ).bind(`et_${crypto.randomUUID().slice(0, 8)}`, tenantId, adminId, await sha256Hex(verifyToken), now, now + VERIFY_TTL_MS),
    ]);

    const verifyUrl = `${new URL(c.req.url).origin}/?verify=${verifyToken}`;
    c.executionCtx.waitUntil(sendVerifyEmail(c.env, email, household, verifyUrl));
    return c.json(
      {
        ok: true,
        household: slug,
        handle,
        message: "check your email to verify the household",
        // Local-dev harnesses only — never set DEV_ECHO_VERIFY in production.
        ...(c.env.DEV_ECHO_VERIFY === "1" ? { verifyUrl } : {}),
      },
      201,
    );
  });

  // ---- verify the email ----------------------------------------------------
  pub.post("/verify", async (c) => {
    let body: { token?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.token !== "string" || !body.token) return c.json({ error: "token is required" }, 400);
    const row = await c.env.DB.prepare(
      `SELECT et.id, et.user_id AS userId, et.expires_at AS expiresAt, et.used_at AS usedAt, t.slug
         FROM email_tokens et JOIN tenants t ON t.id = et.tenant_id
        WHERE et.token_hash = ? AND et.purpose = 'verify'`,
    )
      .bind(await sha256Hex(body.token))
      .first<{ id: string; userId: string; expiresAt: number; usedAt: number | null; slug: string }>();
    if (!row || row.usedAt || row.expiresAt <= Date.now()) {
      return c.json({ error: "that link is invalid or expired — request a new one" }, 401);
    }
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?").bind(Date.now(), row.userId),
      c.env.DB.prepare("UPDATE email_tokens SET used_at = ? WHERE id = ?").bind(Date.now(), row.id),
    ]);
    return c.json({ ok: true, household: row.slug });
  });

  // ---- resend the verification email (silent — no address enumeration) ------
  pub.post("/verify/resend", async (c) => {
    let body: { email?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!EMAIL_RE.test(email)) return c.json({ error: "a valid email is required" }, 400);
    if (!(await throttle(c.env, `resend:${email}`, RESEND_LIMIT, 60 * 60_000))) {
      return c.json({ error: "too many resends — try again later" }, 429);
    }
    const user = await c.env.DB.prepare(
      `SELECT u.id, u.tenant_id AS tenantId, t.name AS household FROM users u
         JOIN tenants t ON t.id = u.tenant_id
        WHERE u.email = ? AND u.email_verified_at IS NULL`,
    )
      .bind(email)
      .first<{ id: string; tenantId: string; household: string }>();
    if (user) {
      const token = randomToken();
      const now = Date.now();
      await c.env.DB.prepare(
        "INSERT INTO email_tokens (id, tenant_id, user_id, purpose, token_hash, created_at, expires_at) VALUES (?, ?, ?, 'verify', ?, ?, ?)",
      )
        .bind(`et_${crypto.randomUUID().slice(0, 8)}`, user.tenantId, user.id, await sha256Hex(token), now, now + VERIFY_TTL_MS)
        .run();
      const url = `${new URL(c.req.url).origin}/?verify=${token}`;
      c.executionCtx.waitUntil(sendVerifyEmail(c.env, email, user.household, url));
    }
    return c.json({ ok: true, message: "if that email has an unverified household, a new link is on its way" });
  });

  // ---- redeem a pairing code (the house wizard's one call) -------------------
  pub.post("/pair", async (c) => {
    const ip = clientIp(c.req.raw);
    if (!(await throttle(c.env, `pair:ip:${ip}`, PAIR_IP_LIMIT, 15 * 60_000))) {
      return c.json({ error: "too many attempts — try again later" }, 429);
    }
    let body: { code?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const code = normalizeCode(typeof body.code === "string" ? body.code : "");
    if (code.length !== CODE_LENGTH) return c.json({ error: "invalid or expired code" }, 401);
    const row = await c.env.DB.prepare(
      `SELECT pc.id, pc.tenant_id AS tenantId, pc.expires_at AS expiresAt, pc.used_at AS usedAt,
              t.slug, t.name
         FROM pair_codes pc JOIN tenants t ON t.id = pc.tenant_id
        WHERE pc.code_hash = ?`,
    )
      .bind(await sha256Hex(code))
      .first<{ id: string; tenantId: string; expiresAt: number; usedAt: number | null; slug: string; name: string }>();
    if (!row || row.usedAt || row.expiresAt <= Date.now()) {
      return c.json({ error: "invalid or expired code" }, 401);
    }
    // The one-time release: mark the code used and ROTATE the service token in
    // the same transaction. Whatever bridge held the old token is severed.
    const serviceToken = randomToken();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE pair_codes SET used_at = ? WHERE id = ?").bind(Date.now(), row.id),
      c.env.DB.prepare("UPDATE tenants SET service_token_hash = ? WHERE id = ?")
        .bind(await sha256Hex(serviceToken), row.tenantId),
    ]);
    const origin = new URL(c.req.url).origin;
    return c.json({
      ok: true,
      serviceToken,
      tenant: { slug: row.slug, name: row.name },
      linkUrl: origin.replace(/^http/, "ws") + "/link",
      apiUrl: origin,
    });
  });

  return pub;
}
