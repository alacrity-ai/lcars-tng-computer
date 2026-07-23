# Tricorder cloud (TNGC-14/15)

The public face at **tricorder.lalalimited.com**: Cloudflare Worker (Hono) +
one **TenantHub** Durable Object per tenant + D1 identity + the **Library**
(TNGC-23: D1 metadata index + R2 `tricorder-library` payload bucket, fronted
exclusively by the Worker), serving the **Tricorder PWA** (`./public` —
login, hold-to-talk, type mode, Library screen, admin console). Phones POST
transcripts in; the home bridge holds an **outbound** WebSocket and receives
them — nothing on the internet ever connects into the house. Design docs:
`docs/TRICORDER_LIBRARY_IMPLEMENTATION_DESIGN.md` (architecture) +
`docs/TRICORDER_LIBRARY_PWA_UX_DESIGN.md` (phone UX).

- Contract (the only cloud↔home coupling): `packages/contract`
- Queue semantics: persist in DO storage → push → bridge acks at
  hand-to-session → replay unacked on reconnect → **60s TTL at replay**
  (voice is ephemeral; stale drops are logged, visible in `wrangler tail`).
- Identity (TNGC-15): **users, not devices**. `tenants` / `users` /
  `sessions` in D1. Users carry a PBKDF2 password hash and a role
  (`admin` | `member` | `guest`); a session is a login on a device *label*
  ("leif @ iPhone") — the same user holds any number concurrently. Session
  tokens and the service token are stored as SHA-256 hashes.
  Tenant `home`, users `leif` (admin) `ariel` (member) `guest` (guest).

## Endpoints

| | Auth | What |
|---|---|---|
| `GET /` (+ assets) | none | the PWA |
| `GET /health` | none | liveness + contract version |
| `GET /link` | tenant service token (Bearer or `?token=`) | WSS upgrade for the bridge |
| `POST /api/login` `{handle, password, deviceLabel}` | public | → session token. 5 bad tries → 5-min cooldown; guest sessions expire after 24h, member/admin are long-lived |
| `POST /api/logout` | session | revoke own session |
| `GET /api/me` | session | who am I on this device |
| `POST /api/message` `{transcript}` | session | enqueue an utterance (attribution = session's user + device label) |
| `GET /api/status` | session | `{online, queued, pending}` — is the Computer connected, how deep is its queue |
| `GET /api/queue` | session | the bridge's dispatcher snapshot: every waiting command (+ the active one), `mine` flagged |
| `POST /api/queue/:id/withdraw` | session | withdraw a queued command / cancel the active one — own commands only, admin can clear anyone's |
| `GET /api/users` | session (no guest) | handles + names for the Library send picker (everyone but guests, disabled, self) |
| `POST /api/library` `{owner,view,title,props}` | **service token** | ingest a save from the house — derives family, writes R2 + D1; 413 > 256 KB, 409 at 500 items/user |
| `GET /api/library?q=&family=&received=&before=&limit=` | session or service (+`owner=`) | metadata list, newest first, cursor-paged (`before` = created_at) |
| `GET /api/library/:id` | session (own) or service (any) | metadata + payload (streamed from R2) |
| `DELETE /api/library/:id` | session (own/admin) or service | delete row + R2 object |
| `POST /api/library/:id/send` `{to}` | session (own) or service | copy to `to`'s library, `from_user` = source owner; immutable snapshot |
| `POST /api/library/:id/display` | session | put a saved item on the wall via the dispatcher queue — 202 (queued/instant) or 409 wall-offline |
| `GET /api/admin/overview` | admin session | users + their active sessions |
| `POST /api/admin/users` `{handle,name,role,password}` | admin | create user |
| `POST /api/admin/users/:id/password` `{password}` | admin | set password + **revoke all that user's sessions atomically** |
| `POST /api/admin/users/:id/disabled` `{disabled}` | admin | disable (revokes sessions) / re-enable; self-disable blocked |
| `DELETE /api/admin/sessions/:id` | admin | revoke one session |
| `POST /api/admin/rotate-guest` | admin | fresh word-pair guest password (returned **once**) + all guest sessions revoked |

Day-to-day user/password management lives in the PWA's admin console
(visible to admin sessions only); the endpoints above are what it calls.

## Deploy

```bash
cd apps/tricorder
CLOUDFLARE_API_TOKEN=$(agentsecrets get cloudflare_api_token) \
CLOUDFLARE_ACCOUNT_ID=$(agentsecrets get cloudflare_account_id) \
  pnpm exec wrangler deploy
# migrations, when there are new ones:
#   ... pnpm exec wrangler d1 migrations apply tricorder --remote
# logs (stale-drop lines, auth failures):
#   ... pnpm exec wrangler tail tricorder
```

Secrets in agentsecrets: `tricorder_service_token` (bridge link — the bridge
gets its env from `make computer`), `tricorder_password_leif` /
`tricorder_password_ariel` / `tricorder_password_guest` (PWA logins; the
guest copy goes stale whenever the console rotates it, that's fine — rotate
the agentsecrets entry only if you need it current).

## Reset a password from the CLI (bootstrap / lockout recovery)

Normally: admin console → Set password. If the admin is locked out:

```bash
cd apps/tricorder
HASH=$(PW=$(agentsecrets get tricorder_password_leif) node -e '
const c=require("crypto");const s=c.randomBytes(16);
const h=c.pbkdf2Sync(process.env.PW,s,100000,32,"sha256");
process.stdout.write(`pbkdf2$100000$${s.toString("hex")}$${h.toString("hex")}`)')
CLOUDFLARE_API_TOKEN=$(agentsecrets get cloudflare_api_token) \
CLOUDFLARE_ACCOUNT_ID=$(agentsecrets get cloudflare_account_id) \
  pnpm exec wrangler d1 execute tricorder --remote --command \
  "UPDATE users SET password_hash='$HASH', failed_attempts=0, locked_until=NULL WHERE handle='leif'; DELETE FROM sessions WHERE user_id='u_leif';"
```

## Local dev / E2E

```bash
pnpm exec wrangler d1 migrations apply tricorder --local
pnpm exec wrangler dev --port 8790
```

Seed the local D1 with a tenant + users carrying test password hashes, then
drive it with curl: the TNGC-15 card's handoff references the 35-check
battery (cooldown, guest TTL + forced expiry, rotate-guest lockout, atomic
revocation on password change, admin gating, offline visibility).
