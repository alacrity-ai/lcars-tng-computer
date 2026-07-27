# Guest QR — scan the wall, land in the Tricorder as a guest

**Ticket:** TNGC-57 · **Status:** landed 2026-07-26 (design grounded in a read of the code that day)

## The ask

> "If I have guests over, I say *'computer, display guest QR code'*. A big QR
> goes up on the wall. A guest scans it with their phone and lands in the
> Tricorder PWA, already logged in as guest."

Today the only way in is the word-pair guest password: an admin opens the
Tricorder admin console, taps **Rotate guest password**, reads
`nebula-photon-42` off their phone, and each guest types it into the login
form. That works, but it is a spoken secret, it can't be handed out by the
Computer, and there's nothing to put on the wall.

---

## Code audit — what already exists

### Identity plane (cloud)

`apps/tricorder/src/worker.ts` is the whole public API. Relevant facts:

| Fact | Where |
|---|---|
| Roles are `admin \| member \| guest` | `worker.ts:32` |
| Sessions = 32 random bytes, stored **hashed** (SHA-256) in `sessions` | `auth.ts:50-58`, `worker.ts:179-185` |
| Guest sessions already expire — 24 h | `worker.ts:28` (`GUEST_SESSION_TTL_MS`), applied at `worker.ts:178` |
| `lookupSession` rejects disabled users and deletes expired rows on read | `worker.ts:196-214` |
| A `guest` user row is created for **every** household at registration, `disabled = 1`, **no password hash** | `register.ts:182-184` |
| `POST /api/admin/rotate-guest` sets a fresh word-pair password, clears `disabled`, and revokes every guest session — atomically | `worker.ts:818-832` |
| Guests are already fenced out of library, calendar, plugins, viewscreen, `/api/users` | `worker.ts:243-248, 276, 397, 416, 428`; `calendar.ts:134` |

So **the guest identity, its session TTL, and its blast radius already exist.**
What's missing is a way to *hand someone a session without a password*.

### Short-lived credential precedent

Pairing codes (`register.ts:96-125`, `migrations/0004_multitenant.sql`) are
exactly the shape needed: minted by an authenticated actor, stored **hashed**,
TTL-bounded, one live code per tenant (minting deletes unused predecessors),
redeemed at a **public, IP-throttled** endpoint that returns a uniform error.
`throttle()` (`register.ts:37-54`) is a D1-backed fixed window, reusable.

Email verification also proves the URL-parameter pattern end to end:
`/?verify=<token>` → `handleVerifyParam()` (`public/index.html:1096-1112`)
redeems it and **scrubs the param** with `history.replaceState`.

### The PWA

One file: `apps/tricorder/public/index.html` (~138 KB, vanilla JS).

- Session lives in `localStorage` as `tricorder.token` / `tricorder.user`
  (`index.html:975-980`).
- `enterMain(identity)` is the "you're in" entry point (`index.html:1052`).
- Boot (`index.html:3138-3161`): a first-time visitor with **no** token and no
  deep-link param is bounced to `/welcome` (`:3144`). **Any new entry param has
  to be added to that condition or a guest's brand-new phone lands on the
  marketing page instead of the app.**

### Panels

The SOP `docs/sops/adding-new-panels.md` still points at `apps/web/src/panels/`.
Panels moved to `packages/panel-renderer/src/panels/` in TNGC-37 so the wall
(`apps/web`) and the Tricorder viewscreen stage (`apps/tricorder/renderer`)
render from one source. Three layers still must stay in sync:

1. `packages/shared/src/index.ts` — props interface + the view name in
   `PANEL_VIEWS` (`:22-50`)
2. `packages/panel-renderer/src/panels/<Name>Panel.tsx`
3. `packages/panel-renderer/src/panels/registry.tsx` — `REGISTRY` is a **total**
   `Record<PanelView, …>` (`:47`), so a view without a component fails to compile

Styles are one file, `packages/panel-renderer/src/lcars.css`, sectioned by panel.

### The hands

`packages/console-mcp/src/index.ts` is the Computer's MCP. The **calendar** tool
(`:741+`) is the precedent this feature copies: an MCP tool that calls the cloud
with the tenant **service token** via `cloudFetch` (`packages/library-client`,
which reads `TNG_TRICORDER_URL` / `TNG_TRICORDER_TOKEN` from the container env —
`compose.yaml:66-67`), composes props house-side, and posts them to
`/api/console/display`. The model never hand-builds the payload.

---

## Design

```
"computer, display guest QR code"
        │
        ▼  MCP tool  guest_qr  (console-mcp, service token)
   POST /api/guest-invite            ──▶ mint invite (hashed, TTL, claim cap)
        │                                enable the guest identity
        ▼  { url, expiresAt }
   POST /api/console/display  { view: "qr", props: { url, expiresAt, … } }
        │
        ▼
      the wall renders a big LCARS QR of  https://myhome.computer/?guest=<token>
        │
        │  guest scans
        ▼
   PWA boot sees ?guest=<token>  ──▶ POST /api/guest-claim  ──▶ guest session (24 h)
                                     scrub the param, enterMain()
```

### Decisions, and what was rejected

**The QR carries a purpose-built invite token — not the guest password.**
Encoding `?handle=guest&password=nebula-photon-42` would have been ~20 lines,
but it prints the standing household password into every guest's URL bar,
browser history, and any photo of the wall, and it survives rotation only by
accident. An invite is separately revocable, separately expiring, and never
reveals the password. It also means the *guest never sees a credential at all*.

**One live invite per tenant, multi-claim, TTL-bounded.** A party is many
phones over one evening, so single-use is wrong; unlimited is worse. Default
**60 minutes, 20 claims**, both bounded at mint. Minting again invalidates the
predecessor (same rule as pair codes) — "show the QR again" never leaves two
live doors.

**Minting opens guest access (`disabled = 0`).** The guest row ships disabled,
so without this the very first QR would 403 every scanner. Putting the code on
the wall *is* the deliberate act of opening the door, exactly like tapping
Rotate guest password. Stated plainly in the tool result and the skill so it is
never a surprise. Admin disable still wins afterwards: `lookupSession` rejects
disabled users, so it kills live guest sessions **and** further claims.

**Rotate guest password also kills live invites.** It is the "party's over"
button; leaving a scannable QR alive behind it would be a hole. One extra
statement in the existing atomic batch (`worker.ts:825-830`).

**The panel takes a URL, not a pre-rendered image.** The QR matrix is computed
in the panel from `qrcode-generator` (MIT, dependency-free, ships ESM + types)
and drawn as inline SVG. Props stay ~100 bytes, the panel is self-describing, it
re-renders crisply at any wall size, and it works identically on the Tricorder
viewscreen stage. Rejected: rendering the SVG house-side like the diagram asset
cache — that trick exists to keep 33 k characters out of *model context*, which
a 78-character URL doesn't need.

**`qr` is a general panel, not a guest-specific one.** "Put this link on the
wall as a QR" is a reasonable thing to ask for its own sake; the guest flow is
one caller of it.

**The invite URL is never returned to the model.** `guest_qr` displays the panel
itself and reports back only the expiry and the claim cap. A live credential has
no business sitting in a transcript that gets compacted, logged, and relayed.

**Service plane only.** No PWA admin button for minting in this ticket — the
wall is the ask, and every extra surface is another way to leak an invite.
Noted as deferred below.

---

## Change set

### Cloud — `apps/tricorder`

**`migrations/0007_guest_invites.sql`** (new)

```sql
CREATE TABLE guest_invites (
  id          TEXT PRIMARY KEY,          -- gi_<uuid-slice>
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  token_hash  TEXT NOT NULL UNIQUE,      -- SHA-256, same at-rest rule as sessions
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  max_claims  INTEGER NOT NULL,
  claims      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_guest_invites_tenant ON guest_invites (tenant_id, created_at DESC);
```

**`src/guest.ts`** (new) — mounted at `/api` **before** the session gate, like
`registerRoutes()`; owns its own auth.

- `POST /guest-invite` — **service token only** (same lookup as `calendar.ts:124`).
  Body `{ minutes?: 5..720, maxClaims?: 1..50 }`. Atomically: delete this
  tenant's existing invites, insert the new one, set the guest user
  `disabled = 0`. Returns `{ url, token, expiresAt, maxClaims, guestOpened }`.
  404 if the household has no guest-role user.
- `POST /guest-claim` — **public**, IP-throttled (10 / 15 min, reusing
  `throttle`). Body `{ token, deviceLabel? }`. Validates: invite exists, not
  expired, `claims < max_claims`, guest user exists and is not disabled. Then
  atomically increments `claims` and inserts a `sessions` row with the standard
  24 h guest expiry. Returns the same shape as `/api/login`
  (`{ token, user, deviceLabel, expiresAt }`) so the PWA reuses one code path.
  Every failure returns the identical 401 `"that guest code is invalid or expired"`.
- Exports `GUEST_SESSION_TTL_MS` (moved from `worker.ts`) so login and claim
  can't drift apart.

**`src/worker.ts`** — mount `guestRoutes()`; import the TTL from `guest.ts`;
add `DELETE FROM guest_invites WHERE tenant_id = ?` to the `rotate-guest` batch.

**`public/index.html`** — boot handling for `?guest=<token>`:
- add `guestToken` to the `/welcome` bypass at `:3144`
- scrub the param immediately (`history.replaceState`), mark `tricorder.seen`
- if an existing session is still valid, **keep it** and toast "already signed
  in as X" — a household member who scans the wall must not be downgraded to guest
- otherwise `POST /api/guest-claim` → store token/user → `enterMain()`
- on failure, land on the login view with the error

### Panel — `packages/shared`, `packages/panel-renderer`

- `shared/src/index.ts`: `"qr"` in `PANEL_VIEWS`; `QrPanelProps { url, title?, caption?, expiresAt?, hint? }`
- `panel-renderer/src/panels/QrPanel.tsx`: matrix from `qrcode-generator`
  (`typeNumber 0` = auto-fit, ECC **M**), drawn as one SVG `<path>` of module
  rects on an LCARS-gold field, with a quiet zone. Renders `caption`, and an
  expiry line that flips to a hard **EXPIRED** state once `expiresAt` passes
  (so a recalled panel can never masquerade as a live door). Bad/oversized input
  renders a legible error, never a crash.
- `panel-renderer/src/panels/registry.tsx`: `qr: QrPanel`
- `panel-renderer/src/lcars.css`: `/* ---------- QR panel (TNGC-57) ---------- */`
- `panel-renderer/package.json`: `+ "qrcode-generator": "^2.0.4"`

### Hands — `packages/console-mcp`

- `guest_qr` tool: `{ minutes?, maxClaims?, wall? }` → `cloudFetch("POST", "/api/guest-invite")`
  → `call("/api/console/display", { view: "qr", props, wall })` → returns
  `"Guest QR is on the wall — good for 60 minutes, up to 20 phones."` **The URL
  is not in the result.**
- `display` description gains the `qr` view (generic use).

### Runtime knowledge — `claude/`

- `.claude/skills/guests/SKILL.md` (new): what to say, what `guest_qr` does,
  that minting opens guest access, what a guest can and cannot do, and how the
  party ends (Rotate guest password in the admin console, which also kills the
  QR). Explicit: **never save a guest QR to the library** — the token dies, the
  panel doesn't.
- `CLAUDE.md`: capability-table row → `guests`.

### Docs

- `docs/sops/adding-new-panels.md`: correct the stale `apps/web/src/panels/`
  paths to `packages/panel-renderer/src/panels/` (found during this audit).
- `apps/tricorder/README.md`: the two new endpoints + the migration.

---

## Security posture

| Risk | Mitigation |
|---|---|
| Invite leaks (photo of the wall, shoulder surf) | TTL ≤ 12 h (60 min default), claim cap, single live invite, revoked by rotate-guest |
| Invite at rest | SHA-256 hashed in D1 — same rule as sessions and pair codes |
| Brute-forcing `/guest-claim` | 256-bit token + IP throttle (10 / 15 min) + uniform 401 |
| A guest doing household things | Unchanged: guests are already refused library, calendar, plugins, viewscreen, `/api/users`; sessions expire in 24 h |
| Credential in model context / transcripts | `guest_qr` never returns the URL |
| Stale QR still on screen after the party | Panel renders EXPIRED past `expiresAt`; claims fail regardless |
| Member scans the wall and loses their session | Boot keeps a valid existing session and toasts instead of claiming |

---

## Test plan

**1. Typecheck** — `pnpm -r typecheck`, all 9 workspaces. ✅

**2. Cloud battery on miniflare** — fresh local D1, seeded with a tenant whose
guest row starts `disabled = 1` exactly as registration leaves it, then 28
checks. ✅ all green:

- mint refuses no-token and wrong-token (401 both)
- mint returns a `/?guest=tri_…` URL, echoes the cap, reports `guestOpened`,
  and the guest row flips to `disabled = 0`
- claim returns a guest session; `/api/me` agrees; expiry lands in 23–25 h
- that guest session is still 403 on library, calendar, plugins and viewscreen
- the claim cap holds (2nd ok, 3rd refused); minting again kills the old token
- garbage tokens, expired invites and an admin-disabled guest all return the
  identical 401
- `rotate-guest` reports `revokedInvites`, kills the QR minted before it, and
  the guest sessions with it

**3. Panel** — matrix verified independently of the component (78-char invite
URL → version 5, 37×37, three finder patterns, quiet zone exactly 4 modules,
655 path commands == 655 dark modules), then an SSR render of eight prop
shapes: live, expired (EXPIRED state), URL-only, empty, missing, wrong type,
5 KB payload, and unicode. No crashes; the four bad inputs render the error
state. Rendered live on the office wall and restored. ✅

**4. Production, by hand (Leif)** — say *"computer, display guest QR code"*,
scan with a phone that has never opened the PWA (must **not** land on
`/welcome`), and with a phone already logged in as a member (must stay a
member).

## Landing

1. Merge to `main` (repo persona `leifktaylor`, GitHub `alacrity-ai/lcars-tng-computer`).
2. **`pnpm -C apps/tricorder build:vs`** — rebuild the viewscreen stage. This
   bit me: `public/vs/` is a gitignored prebuilt bundle of `panel-renderer`,
   `wrangler deploy` just uploads whatever is sitting there, so the first
   deploy shipped a stale renderer and every phone in Viewscreen mode showed
   *"Panel qr is not yet installed"* while the wall was fine. Now written into
   `docs/sops/adding-new-panels.md` step 6 and the tricorder README.
3. `wrangler d1 migrations apply tricorder --remote` then `wrangler deploy`
   (creds per `apps/tricorder/README.md`).
4. The wall picks the panel up from Vite HMR; a kiosk tab that was already open
   when the panel landed needs one reload (or a stack restart).
5. **The Computer session must be restarted (`make computer`) to see the new
   `guest_qr` tool and the `guests` skill** — MCP tool lists are read at launch.

## Deferred (not this ticket)

- A **Guest QR** button in the PWA admin console (mint + render the QR on the
  admin's own phone) — useful when Leif is at the door and the wall is in
  another room.
- Per-guest identities (one row per scanned phone) instead of one shared guest
  account — real attribution, but it needs a lifecycle/cleanup story.
- Auto-blank the wall after the last claim or on expiry.
