/**
 * Guest QR invites (TNGC-57) — "computer, display guest QR code".
 *
 * The house mints an invite with the tenant service token, the wall renders it
 * as a QR, and a guest's phone trades it for an ordinary guest session. The
 * guest never handles a credential: no password is spoken at the door, typed
 * into a phone, or left readable in a photo of the wall.
 *
 * Two planes, both mounted BEFORE the /api/* session gate because they own
 * their own auth:
 *   POST /api/guest-invite — service token only (the house). Mints.
 *   POST /api/guest-claim  — public, IP-throttled. Redeems.
 *
 * Shape borrowed from pair codes (register.ts): stored hashed, TTL-bounded,
 * one live invite per tenant, uniform failure. Differences, both deliberate:
 * an invite is MULTI-claim (a party is many phones) but claim-capped, and
 * minting OPENS guest access — putting the code on the wall is the act of
 * opening the door, exactly like tapping Rotate guest password.
 */
import { Hono } from "hono";
import type { Env } from "./hub";
import { randomToken, sha256Hex } from "./auth";
import { clientIp, throttle } from "./register";

/** How long a claimed guest session lives. Shared with /api/login so the two
    ways into the guest identity can never drift apart. */
export const GUEST_SESSION_TTL_MS = 24 * 60 * 60_000;

const DEFAULT_INVITE_MINUTES = 60;
const MIN_INVITE_MINUTES = 5;
const MAX_INVITE_MINUTES = 720; // 12h — a QR that outlives the party is a hole
const DEFAULT_MAX_CLAIMS = 20;
const MAX_MAX_CLAIMS = 50;
const MAX_DEVICE_LABEL_CHARS = 40;
const CLAIM_IP_LIMIT = 10; // per 15 min per IP
const CLAIM_WINDOW_MS = 15 * 60_000;

/** Every claim failure says exactly this — expired, spent, revoked, disabled,
    and never-existed are indistinguishable from outside. */
const CLAIM_DENIED = "that guest code is invalid or expired";

type Vars = Record<string, never>;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function guestRoutes() {
  const g = new Hono<{ Bindings: Env; Variables: Vars }>();

  // ---- mint (the house, service token) ---------------------------------------
  g.post("/guest-invite", async (c) => {
    const header = c.req.raw.headers.get("authorization");
    const token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const tenant = await c.env.DB.prepare("SELECT id FROM tenants WHERE service_token_hash = ?")
      .bind(await sha256Hex(token))
      .first<{ id: string }>();
    if (!tenant) return c.json({ error: "unauthorized" }, 401);

    let body: { minutes?: unknown; maxClaims?: unknown } = {};
    try {
      body = (await c.req.json()) as { minutes?: unknown; maxClaims?: unknown };
    } catch {
      // An empty body is the common case (all defaults) — not an error.
    }
    const minutes = clampInt(body.minutes, DEFAULT_INVITE_MINUTES, MIN_INVITE_MINUTES, MAX_INVITE_MINUTES);
    const maxClaims = clampInt(body.maxClaims, DEFAULT_MAX_CLAIMS, 1, MAX_MAX_CLAIMS);

    const guest = await c.env.DB.prepare("SELECT id, disabled FROM users WHERE tenant_id = ? AND role = 'guest'")
      .bind(tenant.id)
      .first<{ id: string; disabled: number }>();
    if (!guest) return c.json({ error: "no guest-role user exists" }, 404);

    const inviteToken = randomToken();
    const now = Date.now();
    const expiresAt = now + minutes * 60_000;
    await c.env.DB.batch([
      // One live door: whatever QR was on the wall before stops working now.
      c.env.DB.prepare("DELETE FROM guest_invites WHERE tenant_id = ?").bind(tenant.id),
      c.env.DB.prepare(
        `INSERT INTO guest_invites (id, tenant_id, token_hash, created_at, expires_at, max_claims)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(`gi_${crypto.randomUUID().slice(0, 8)}`, tenant.id, await sha256Hex(inviteToken), now, expiresAt, maxClaims),
      // Showing the code is the deliberate act of opening guest access — the
      // guest row ships disabled, so without this the first QR would 403 every
      // scanner. Admin disable still wins afterwards (it kills live sessions
      // via lookupSession AND further claims).
      c.env.DB.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL, disabled = 0 WHERE id = ?").bind(
        guest.id,
      ),
    ]);

    return c.json({
      url: `${new URL(c.req.url).origin}/?guest=${inviteToken}`,
      expiresAt,
      minutes,
      maxClaims,
      guestOpened: guest.disabled === 1,
    });
  });

  // ---- claim (a guest's phone, public) ----------------------------------------
  g.post("/guest-claim", async (c) => {
    if (!(await throttle(c.env, `guest-claim:ip:${clientIp(c.req.raw)}`, CLAIM_IP_LIMIT, CLAIM_WINDOW_MS))) {
      return c.json({ error: "too many attempts — try again later" }, 429);
    }
    let body: { token?: unknown; deviceLabel?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.token !== "string" || !body.token) return c.json({ error: CLAIM_DENIED }, 401);
    const deviceLabel =
      (typeof body.deviceLabel === "string" ? body.deviceLabel.trim().slice(0, MAX_DEVICE_LABEL_CHARS) : "") ||
      "guest device";

    const now = Date.now();
    const invite = await c.env.DB.prepare(
      `SELECT gi.id, gi.tenant_id AS tenantId, u.id AS userId, u.handle, u.name, u.disabled
         FROM guest_invites gi
         JOIN users u ON u.tenant_id = gi.tenant_id AND u.role = 'guest'
        WHERE gi.token_hash = ? AND gi.expires_at > ? AND gi.claims < gi.max_claims`,
    )
      .bind(await sha256Hex(body.token), now)
      .first<{ id: string; tenantId: string; userId: string; handle: string; name: string; disabled: number }>();
    if (!invite || invite.disabled) return c.json({ error: CLAIM_DENIED }, 401);

    // The claim cap is enforced by THIS conditional update, not by the read
    // above — two phones scanning at once both pass the read, only one wins a
    // contested last slot. A claim is burned before the session exists, so a
    // failure downstream costs a slot rather than handing out a free one.
    const spend = await c.env.DB.prepare(
      "UPDATE guest_invites SET claims = claims + 1 WHERE id = ? AND claims < max_claims AND expires_at > ?",
    )
      .bind(invite.id, now)
      .run();
    if (!spend.meta.changes) return c.json({ error: CLAIM_DENIED }, 401);

    const sessionToken = randomToken();
    const expiresAt = now + GUEST_SESSION_TTL_MS;
    await c.env.DB.prepare(
      `INSERT INTO sessions (id, tenant_id, user_id, device_label, token_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        `s_${crypto.randomUUID()}`,
        invite.tenantId,
        invite.userId,
        deviceLabel,
        await sha256Hex(sessionToken),
        now,
        expiresAt,
      )
      .run();

    // Same shape as POST /api/login so the PWA lands both through one path.
    return c.json({
      token: sessionToken,
      user: { handle: invite.handle, name: invite.name, role: "guest" },
      deviceLabel,
      expiresAt,
    });
  });

  return g;
}
