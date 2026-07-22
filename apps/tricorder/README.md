# Tricorder cloud (TNGC-14)

The public API at **tricorder.lalalimited.com**: Cloudflare Worker (Hono) +
one **TenantHub** Durable Object per tenant + D1 identity. Phones POST
transcripts in; the home bridge holds an **outbound** WebSocket and receives
them — nothing on the internet ever connects into the house.

- Contract (the only cloud↔home coupling): `packages/contract`
- Queue semantics: persist in DO storage → push → bridge acks at
  hand-to-session → replay unacked on reconnect → **60s TTL at replay**
  (voice is ephemeral; stale drops are logged, visible in `wrangler tail`).
- Identity: `tenants` / `users` / `devices` in D1, tokens stored as SHA-256
  hashes. Tenant `home`, users `leif` `mom` `joe` `guest`.

## Endpoints

| | Auth | What |
|---|---|---|
| `GET /health` | none | liveness + contract version |
| `GET /link` | tenant service token (Bearer or `?token=`) | WSS upgrade for the bridge |
| `POST /api/message` `{transcript}` | device token | enqueue an utterance (attributed from the device row) |
| `GET /api/status` | device token | `{online, queued}` — is the Computer connected |

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

Secrets in agentsecrets: `tricorder_service_token` (bridge link),
`tricorder_device_token_leif` (device "Leif's Phone"). The bridge gets its
env from `make computer`.

## Mint a new device

```bash
TOK=$(node -e 'process.stdout.write("trd_"+require("crypto").randomBytes(32).toString("hex"))')
printf %s "$TOK" | agentsecrets set tricorder_device_token_<who> --scope alacrity \
  --description "Tricorder device token — <Device Name> (user <handle>)"
HASH=$(printf %s "$TOK" | node -e 'const c=require("crypto");let d="";process.stdin.on("data",x=>d+=x).on("end",()=>process.stdout.write(c.createHash("sha256").update(d).digest("hex")))')
CLOUDFLARE_API_TOKEN=$(agentsecrets get cloudflare_api_token) \
CLOUDFLARE_ACCOUNT_ID=$(agentsecrets get cloudflare_account_id) \
  pnpm exec wrangler d1 execute tricorder --remote --command \
  "INSERT INTO devices VALUES ('d_<slug>','home','u_<handle>','<Device Name>','$HASH',$(date +%s%3N),NULL);"
```

## Local dev / E2E

```bash
pnpm exec wrangler d1 migrations apply tricorder --local
pnpm exec wrangler dev --port 8788 --var MESSAGE_TTL_MS:3000
```

Seed the local D1 with test hashes, then run the E2E driver (see the TNGC-14
card for the reference script): it covers link auth, enqueue→await→ack,
online/offline, replay, TTL drop, and 401s against both local and prod.
