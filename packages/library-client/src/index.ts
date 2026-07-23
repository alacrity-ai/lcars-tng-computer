/**
 * House-side client for the Tricorder cloud library (TNGC-23).
 *
 * Runs ONLY inside the fenced computer container — the two processes that
 * import it (console-mcp and the bridge) live there, next to the service
 * token. Payloads flow machine-to-machine through these calls; nothing here
 * ever returns props to model context unless the caller explicitly forwards
 * them to the console server (the display path).
 *
 * Config comes from the env the container already has:
 *  - TNG_TRICORDER_URL   (wss://host/link — the https base is derived)
 *  - TNG_TRICORDER_TOKEN (the tenant service token)
 *  - TNG_TRICORDER_HTTP_URL overrides the derived base (tests, wrangler dev).
 */

export interface LibraryItemMeta {
  id: string;
  family: string;
  view: string;
  title: string;
  bytes: number;
  fromUser: string | null;
  createdAt: number;
}

export interface LibraryList {
  items: LibraryItemMeta[];
  total: number;
  nextBefore: number | null;
}

function httpBase(): string {
  const explicit = process.env.TNG_TRICORDER_HTTP_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const link = process.env.TNG_TRICORDER_URL;
  if (!link) throw new Error("no tricorder cloud configured (TNG_TRICORDER_URL unset)");
  const u = new URL(link);
  const proto = u.protocol === "wss:" ? "https:" : u.protocol === "ws:" ? "http:" : u.protocol;
  return `${proto}//${u.host}`;
}

function serviceToken(): string {
  const t = process.env.TNG_TRICORDER_TOKEN;
  if (!t) throw new Error("no tricorder service token (TNG_TRICORDER_TOKEN unset)");
  return t;
}

async function callCloud<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${httpBase()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${serviceToken()}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch { /* not JSON — raw body is the message */ }
    throw new Error(`library cloud ${res.status}: ${msg}`);
  }
  return JSON.parse(text) as T;
}

/** Save a wall primitive to `owner`'s library. Props go straight from the
    caller (who got them from the console server) to the cloud. */
export function saveItem(args: {
  owner: string;
  view: string;
  title: string;
  props: Record<string, unknown>;
}): Promise<{ id: string; title: string; family: string; view: string; bytes: number }> {
  return callCloud("POST", "/api/library", args);
}

/** Metadata + full payload of one item — the display path's fetch. */
export function getItem(id: string): Promise<{ item: LibraryItemMeta; props: Record<string, unknown> }> {
  return callCloud("GET", `/api/library/${encodeURIComponent(id)}`);
}

/** Metadata-only search of `owner`'s library. */
export function searchItems(args: {
  owner: string;
  q?: string;
  family?: string;
  limit?: number;
}): Promise<LibraryList> {
  const params = new URLSearchParams({ owner: args.owner });
  if (args.q) params.set("q", args.q);
  if (args.family) params.set("family", args.family);
  if (args.limit) params.set("limit", String(args.limit));
  return callCloud("GET", `/api/library?${params}`);
}

/** Copy an item to another user's library (provenance handled cloud-side). */
export function sendItem(id: string, to: string): Promise<{ id: string; to: string; title: string }> {
  return callCloud("POST", `/api/library/${encodeURIComponent(id)}/send`, { to });
}

export function deleteItem(id: string): Promise<{ ok: boolean }> {
  return callCloud("DELETE", `/api/library/${encodeURIComponent(id)}`);
}
