/**
 * Tricorder Worker (TNGC-14) — the public face at tricorder.lalalimited.com.
 *
 * Auth model: this API is on the open internet, so everything is gated.
 *  - devices authenticate with a device token   → POST /api/message, GET /api/status
 *  - the home bridge authenticates with the tenant service token → GET /link (WSS)
 * Tokens are stored hashed (SHA-256) in D1; the queue itself lives in the
 * per-tenant TenantHub Durable Object.
 */
import { Hono } from "hono";
import { CONTRACT_VERSION, type TngMessage } from "@tng/contract";
import type { Env } from "./hub";

export { TenantHub } from "./hub";

const MAX_TRANSCRIPT_CHARS = 2000;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return null;
}

interface DeviceIdentity {
  tenantId: string;
  deviceId: string;
  deviceName: string;
  userHandle: string;
}

type Vars = { device: DeviceIdentity };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.get("/health", (c) =>
  c.json({ ok: true, service: "tricorder", contract: CONTRACT_VERSION, runtime: "cloudflare-worker" }),
);

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

  const hub = c.env.TENANT_HUB.get(c.env.TENANT_HUB.idFromName(tenant.id));
  return hub.fetch(new Request("https://hub/link", c.req.raw));
});

// ---- device API (device token) ----------------------------------------------

app.use("/api/*", async (c, next) => {
  const token = bearerToken(c.req.raw);
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const hash = await sha256Hex(token);
  const row = await c.env.DB.prepare(
    `SELECT d.id AS deviceId, d.tenant_id AS tenantId, d.name AS deviceName, u.handle AS userHandle
       FROM devices d JOIN users u ON u.id = d.user_id
      WHERE d.token_hash = ?`,
  )
    .bind(hash)
    .first<DeviceIdentity & { deviceId: string }>();
  if (!row) return c.json({ error: "unauthorized" }, 401);
  c.set("device", row);
  c.executionCtx.waitUntil(
    c.env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
      .bind(Date.now(), row.deviceId)
      .run(),
  );
  await next();
});

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

  const identity = c.get("device");
  const msg: TngMessage = {
    user: identity.userHandle,
    device: identity.deviceName,
    transcript: body.transcript.trim(),
    ts: Date.now(),
  };
  const hub = c.env.TENANT_HUB.get(c.env.TENANT_HUB.idFromName(identity.tenantId));
  const res = await hub.fetch(
    new Request("https://hub/enqueue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(msg),
    }),
  );
  return new Response(res.body, { status: res.status === 200 ? 202 : res.status, headers: res.headers });
});

app.get("/api/status", async (c) => {
  const identity = c.get("device");
  const hub = c.env.TENANT_HUB.get(c.env.TENANT_HUB.idFromName(identity.tenantId));
  return hub.fetch(new Request("https://hub/status"));
});

export default app;
