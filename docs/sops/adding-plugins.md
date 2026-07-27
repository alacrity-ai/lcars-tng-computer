# Adding a plugin

A plugin is an **optional capability, explicitly enabled per install, never
shipped on by default** — the way household-specific hardware (lighting,
sensors, appliances) and its sidecar services join the Computer without
welding anything into core. This SOP takes you from empty folder to a plugin
as complex as the reference implementation, `plugins/lighting/` — read that
plugin side-by-side with this document; every pattern here is proven there.

Design rationale and the full security model: [`../PLUGIN_SYSTEM_DESIGN.md`](../PLUGIN_SYSTEM_DESIGN.md).

## The mental model

```
                        THE FENCED BRAIN (computer container)
                        │  your MCP server runs in here,
                        │  fence hole ONLY to your service
                        ▼ HTTP
   wall ◄── composite ── your service (sidecar) ── your other sidecars
        panel POSTs      owns all state, volumes    (brokers, bridges, DBs)
                         talks to the hardware/world
```

Six extension points, all optional, all declared in one manifest:

| Extension point | Mechanism | Runs where |
|---|---|---|
| **Sidecar containers** | `compose.yaml` chained after core | Compose network |
| **Backend service** | Your own container + Dockerfile | Compose network |
| **MCP tool(s)** | Merged into the generated `claude/.mcp.json` at boot | INSIDE the fenced brain |
| **Skills** | Synced as `plugin-<id>-<name>` at boot | Brain's skill dir |
| **Wall panels** | The `composite` block language, POSTed by your service | The wall renders; **no plugin code ever executes in the wall** |
| **Tricorder face** (step 7) | Bridge roster + Worker endpoints + a PWA screen; the tile's look comes from the manifest | Phone → Worker → bridge → your service, **skipping the brain** |

The loader is `docker/plugin-merge.sh` — it runs in BOTH computer entrypoints
(dev + appliance) before `init-firewall.sh`, is driven entirely by
`TNG_PLUGINS` + `plugins/<id>/plugin.json`, and **regenerates everything from
scratch every boot**: an enabled plugin is exactly `TNG_PLUGINS`; a disabled
plugin leaves ZERO trace (no tool, no skill, no fence hole, no container). A
broken manifest is skipped loudly — a plugin must never brick boot.

## Three kinds of plugin — decide which you are FIRST

The diagram above is the house-side case. It is no longer the only one, and
the kind determines what you build, where the code lives, and — the part
households actually feel — **whether it still works when the Computer is off**.

| Kind | Exemplar | Where the work happens | Alive when the Computer is off? | Manifest? |
|---|---|---|---|---|
| **Sidecar** | `plugins/lighting/` | Your container on the compose network; the brain reaches it through a pinpoint fence hole | ✗ — the bridge is the only path in | yes, the full one |
| **Host service** | `plugins/claudeops/` | A process on the HOST, outside every fence; the plugin declares only the hole to it (`host.docker.internal:PORT`) and flags the bridge with an env var | ✗ | yes, but no `compose.yaml` services of its own |
| **Cloud-native** | `calendar` (TNGC-52) | Behind the Worker itself — D1/R2, no bridge, no sidecar | **✓ always online** | **none** — it has no folder in `plugins/` |

Choosing:

- Does it touch **hardware, the LAN, or the host**? → sidecar (or host service
  if the process must live outside the fences, like a tmux session).
- Is it **household data with no local dependency** (a calendar, a list, a
  budget)? → cloud-native. It survives a power cut to the office box, phones
  keep working on the road, and it needs no fence holes at all.
- Split systems are fine and normal: `lights` is a sidecar plugin whose
  *deterministic* controls skip the brain entirely (step 7) while its *spoken*
  controls go through the MCP tool.

**A cloud-native plugin does not use this SOP's steps 1–6.** It has no
manifest, no loader entry, and `TNG_PLUGINS` has nothing to do with it. It is:
routes in `apps/tricorder/src/<name>.ts`, a migration, an entry in
`CLOUD_PLUGINS` in `apps/tricorder/src/worker.ts` (id + name + `online: true` +
its tile, since there's no manifest to read one from), a PWA screen, and —
if the Computer should be able to speak it too — an MCP tool in
`packages/console-mcp` that reaches the cloud with the tenant service token
via `cloudFetch` (see the `calendar` tool). It still respects the same
household switch: `tenant_plugins` + the admin's Enable-plugins sheet.

## Hard rules (learned the hard way — do not relearn them)

1. **State is born in plugin-owned named volumes.** Never pair hardware, form
   networks, or initialize databases before the plugin's compose exists —
   otherwise the state lives somewhere the plugin doesn't own.
2. **The brain gets pinpoint holes, not subnets.** Its only path to your
   sidecars is the `internalEndpoints` you declare (`host:port`, resolved to
   `ip:port` iptables holes at boot). MCP → your service over HTTP; your
   service → everything else. The brain never talks to your broker/DB/bridge
   directly.
3. **No host ports** except loopback-only operator UIs
   (`127.0.0.1:PORT:...`), and never on the LAN.
4. **Dangerous operations are not MCP tools.** Opening a mesh to joins,
   factory resets, credential changes — human decisions. Put them on your
   service's HTTP surface (in-network) or the sidecar's own UI, document
   them in the plugin README, and leave them out of the tool schema.
5. **No secrets in the repo.** Nothing in `plugin.json`, `compose.yaml`, or
   code. Parameterize via env (`${MY_PLUGIN_THING:-default}`) and document
   the variables. Defaults may be private-LAN addresses (RFC1918 is fine in
   a public repo); they may never be credentials.
6. **Pin image versions.** `koenkk/zigbee2mqtt:2.12.1`, not `latest` — a
   surprise major bump mid-reboot is how appliances die. Verify a tag exists
   before pinning; inspect the image's entrypoint before wrapping it.
7. **Commit messages / cards use the ticket key**, and the plugin versions
   independently of core (`version` in plugin.json; bump on every behavior
   change).

## Step 0 — scaffold

```
plugins/<id>/
  plugin.json          # the manifest (JSON — the loader is bash+jq, NOT yaml)
  compose.yaml         # sidecars (optional)
  service/             # your backend container (optional)
    Dockerfile
    package.json
    src/
  mcp/
    server.mjs         # MCP server, zero-dependency (see step 5)
  skills/<name>/
    SKILL.md
  README.md            # what it needs, how to enable, ops procedures
```

`<id>`: lowercase `[a-z0-9_-]` only — anything else is skipped by the loader.

## Step 1 — plugin.json

```json
{
  "id": "lighting",
  "name": "Zigbee Lighting",
  "version": "0.3.0",
  "minCore": "0.3.0",
  "description": "One line — printed in the boot banner.",
  "ui": {
    "color": "#ff9900",
    "icon": {
      "viewBox": "0 0 24 24",
      "paths": ["M9 18h6", "M10 21h4", "M12 2a7 7 0 0 0-4 12.8V18h8v-3.2A7 7 0 0 0 12 2z"]
    }
  },
  "services": [
    { "name": "mosquitto" },
    { "name": "zigbee2mqtt" },
    { "name": "lighting", "internalEndpoints": [{ "host": "lighting", "port": 7101 }] }
  ],
  "mcp": { "name": "lights", "command": "node", "args": ["../plugins/lighting/mcp/server.mjs"] },
  "skills": ["lighting"],
  "allowedDomains": []
}
```

- **`ui` — REQUIRED (TNGC-58).** How your plugin looks on the tricorder's
  plugin grid: a square tile in `ui.color` carrying `ui.icon` as its glyph.
  Core hardcodes nothing — a new plugin arrives with its own look.
  - `color` — `#rrggbb`, the tile background. Pick something no other enabled
    plugin uses; the grid is scanned by color before it is read. LCARS
    palette: gold `#ff9900`, lavender `#cc99cc`, blue `#9999cc`, peach
    `#ffcc99`, red `#cc6666`. The phone picks black or white lettering from
    the color's luminance, so mid-tones are fine.
  - `icon` — `{viewBox, paths[], fill?}`. **Path DATA, not an SVG string**: a
    manifest is house-authored content, so the phone builds the `<svg>` from
    validated `d` attributes and never renders markup you supply. Paths are
    stroked (Lucide/Feather style, `stroke-linecap: round`) unless you set
    `"fill": true`. Up to 12 paths, 600 chars each, and the charset is
    restricted to path commands and numbers — anything else drops the tile.
    Lift `d` values straight out of a Lucide icon; convert `<circle>`/`<line>`
    primitives to paths first.
  - A missing or invalid `ui` **never disables your plugin** — it costs it the
    look. The loader prints `ui MISSING` at boot and the bridge logs which
    field failed; the tile falls back to a grey generic. Fix it and restart.

- `services[].internalEndpoints` — every hole the brain gets. Declare ONLY
  what the MCP server actually calls (usually just your service). `tng
  doctor` probes each one at `http://host:port/health` and expects JSON with
  `ok` not `false`.
- `mcp.args` — **relative paths, relative to the `claude/` directory** (the
  MCP server's cwd). `../plugins/<id>/mcp/server.mjs` resolves correctly in
  BOTH dev (`/home/node/tng-computer/claude`) and appliance
  (`/opt/tng/claude`) — never hardcode either absolute prefix.
- `allowedDomains` — EXTERNAL egress for the brain, printed at boot. Keep it
  `[]` for anything fully local; every entry widens the fence.
- `skills` — informational; the loader syncs every directory under `skills/`
  regardless, as `plugin-<id>-<dirname>`.

## Step 2 — compose.yaml (sidecars)

Chained after the core file (`docker compose -f compose.yaml -f
plugins/<id>/compose.yaml …` — the Makefile assembles this from
`TNG_PLUGINS`). All services land on the same compose network with DNS by
service name (`stack`, `computer`, yours).

```yaml
services:
  my-broker:
    image: vendor/broker:1.2.3            # PINNED
    init: true
    volumes:
      - myplugin-broker-data:/data        # plugin-owned named volume

  my-service:
    build: ./plugins/myplugin/service     # path from REPO ROOT (compose project dir)
    image: tng-plugin-myplugin
    init: true
    depends_on: [my-broker]
    environment:
      BROKER_URL: mqtt://my-broker:1883
      STACK_URL: http://stack:3789        # the wall server, for panels
      PORT: "7101"

  # Ride the core lifecycle: `up stack` starts your sidecars, and the fence
  # can resolve your endpoints when the computer boots.
  stack:
    depends_on: [my-broker, my-service]
  computer:
    depends_on: [my-service]

volumes:
  myplugin-broker-data:
```

Patterns proven in lighting:

- **Extending `stack:`/`computer:` with `depends_on`** is what ties your
  sidecars to `make dev` / `make computer`. Without the `computer:` entry the
  fence's endpoint resolution can race your sidecar's startup (a WARN in the
  firewall output means exactly this — relaunch after sidecars are up).
- **First-boot config seeding**: when a sidecar needs a config file in its
  volume, wrap its entrypoint — `if [ ! -f …/config ]; then cat > … <<EOF …
  EOF; fi; exec <original command>`. Inspect the image first (`docker image
  inspect --format '{{json .Config.Entrypoint}} {{json .Config.Cmd}}'`) and
  exec what it actually runs. Seed once; after that the sidecar owns its
  config. `$$VAR` in compose = literal `$VAR` for the shell (compose
  interpolation escaping).
- **Operator UI**: publish to host loopback only —
  `"127.0.0.1:8092:8080"`.

## Step 3 — the service

Your service is a **standalone container** — its own Dockerfile, its own
(minimal) dependencies, NOT part of the pnpm workspace. This keeps the plugin
folder self-contained and buildable anywhere, including the appliance host.

The HTTP contract that makes the rest of the system work:

| Route | Contract |
|---|---|
| `GET /health` | `{ ok: boolean, ...diagnostics }` — `ok:false` when your upstream link is down. `tng doctor` reads this. |
| `GET /state` | Full cached state, JSON. The MCP server formats it for the model — answer questions from cache, never probe hardware per question. |
| `POST /...` verbs | Whatever your domain needs. Validate hard, return `{error}` with proper status codes; `503` + a fixed human sentence when the upstream is offline. |

State-cache lessons (these WILL bite you otherwise):

- **Mirror, don't poll**: subscribe to your upstream's event stream and keep
  a cache. Status must be instant.
- **Know what's retained**: brokers retain some topics (rosters, bridge
  info) and not others (live state). A fresh service start knows the roster
  but not current state — **actively probe each unknown entity once on
  connect** (lighting publishes a `/get` per device; the cache warms in
  <1 s).
- **Never report a stale cache as live**: gate "upstream online" claims on
  the *connection* being up, not on the last cached value.
- **Optimistic upstreams lie**: some bridges report the state you requested,
  not the state that resulted (Z2M reports the color you asked for while a
  colorloop keeps spinning). Where a device mode can override commands, have
  the service resolve the conflict itself (lighting broadcasts
  `stop_colorloop` before any color-intent command). The model cannot fix
  what it cannot see.
- **Reconnect forever**: broker restarts must self-heal (mqtt.js
  `reconnectPeriod`, re-probe on connect). Test it (step 8).

## Step 4 — the wall panel (composite)

Plugins render through the **composite block language** only — POST
`{"view":"composite","props":{…}}` to `STACK_URL/api/console/display`. Blocks:
`group`, `readout`, `status` (chip, plus optional inline `icon`/`value`/
`swatch` — one entity per row), `gauge`, `text`, `list`, `keyvalue`,
`sparkline`, `swatch` (a rendered color chip), `svg` (same-origin path only),
`divider`. Limits enforced server-side: ≤64 blocks, nesting ≤3, ≤16 KB,
strict formats (`gauge.value` 0..1, `swatch.color`/`status.swatch` `#rrggbb`).
Full schema:
`packages/shared/src/index.ts` + `claude/.claude/skills/composite/SKILL.md`.

The refresh discipline — this is the difference between a live dashboard and
a wall that fights the user:

1. **Your panel `title` is your visibility marker.** Pick a constant
   (`"LIGHTING"`).
2. On demand (`POST /panel` from your MCP tool): compose from cache and POST.
3. On state change: **first GET `/api/console/screen`** — refresh ONLY if
   `view === "composite" && props.title === <your marker>`. Anything else
   means the wall moved on; **never yank it back**.
4. Debounce (~800 ms) and stay under the composite rate limit (2/s; the
   server 429s — back off once and retry).
5. Same-view re-POSTs update in place (no wipe) — that's what makes gauges
   track live.
6. Design for scale: **one block per entity** (`status` carries level and
   color inline — don't stack status + gauge + swatch), then collapse to
   per-zone summaries as you approach the 64-block cap. Lighting's threshold
   is computed, not guessed: `fixtures + rooms + chrome > 64`.

If the language is missing a primitive your panel genuinely needs (lighting
needed `swatch` to show *actual colors*, then `status.icon`/`value`/`swatch`
to fit a fixture on one row): extend it in core — type in `packages/shared`,
validation in `apps/server/src/composite.ts` (strict — composite props are
plugin-supplied input landing on the wall), renderer case in
`packages/panel-renderer/src/panels/CompositePanel.tsx` + `lcars.css`, a line
in the composite skill + the display tool description. Unknown types render as placards on
old walls, so the schema evolves additively. That's a core PR — justify it
in the commit.

Validate before you ever POST: run the real validator against your composed
props (from the stack container):

```bash
docker compose exec -T stack bash -c 'cd /home/node/tng-computer/apps/server && npx tsx - <<EOF
import { validateComposite } from "./src/composite.ts";
const props = await (await fetch("http://<your-service>:7101/panel/preview")).json();
console.log(validateComposite(props) ?? "VALID");
EOF'
```

(Expose a `GET /panel/preview` that returns the composed props without
posting — costs nothing, makes this and future debugging trivial.)

## Step 5 — the MCP server

**Hand-roll it, zero dependencies.** Plugin MCP servers run inside the fenced
computer container where only the repo checkout exists — no install step may
be required, in dev or appliance. The MCP stdio transport is one JSON-RPC
message per line; the entire protocol surface you need is ~40 lines. Copy
`plugins/lighting/mcp/server.mjs` and keep its properties:

- Handle: `initialize` (echo the client's `protocolVersion`), `ping`,
  `tools/list`, `tools/call`, and return empty lists for `resources/list` /
  `prompts/list`. Ignore notifications (no `id`). `-32601` anything else.
- **stdout is protocol only** — all logging to stderr.
- One tool per domain with a verb parameter beats N micro-tools.
- Node ≥18 global `fetch` with `AbortSignal.timeout(…)` — never hang the
  model's tool call.
- Every failure path returns `isError: true` with a **fixed, speakable
  sentence** ("Lighting control is offline.") — the skill tells the model to
  say it verbatim and stop.
- Format tool output for a voice assistant: short lines, human units
  (percent, kelvin, hex), never raw JSON dumps.
- Reach your service at `http://<service>:<port>` (compose DNS), default in
  code, overridable by env.

**Schema staleness — remember this one:** the running session spawns your MCP
server at launch and holds its tool schema. Ship a new parameter and the live
session can't use it until relaunch (`TNG_PLUGINS=<id> make computer`).
Design service-side behavior so the *old* schema's natural moves still do the
right thing (that's why color-intent kills a colorloop server-side), and tell
the operator a relaunch is pending.

## Step 6 — the skill

`skills/<name>/SKILL.md`, standard frontmatter (`name`, `description` — make
the description a routing magnet: list the trigger phrases). Content that has
proven to matter:

- A **routing table**: exact phrase patterns → exact tool calls.
- **Judgment rules**: relative changes ("a bit dimmer" ≈ one spoken step),
  defaults (omit target = whole house), when NOT to probe.
- **Failure behavior**: the fixed offline sentence, said once, no retries, no
  speculation.
- **What is NOT the model's job**: pairing/provisioning is an operator task —
  the skill says where the human does it, not how the model does.

The loader syncs it as `plugin-<id>-<name>` and removes it cleanly when the
plugin is disabled. Never touch core `claude/CLAUDE.md` — plugin capability
must vanish with the plugin. (`claude/.claude/skills/plugin-*/` is gitignored;
the copy in your plugin folder is the source of truth.)

## Step 7 — the tricorder face (optional, and NOT manifest-driven)

Steps 1–6 buy you a plugin the *brain* can drive. Appearing on the phone's
plugin grid — where a tap reaches your service **without waking the model** —
is a separate, deliberate build. The manifest supplies the tile's look and
nothing else; every wire below is hand-written in core, once per plugin.

Know this before you start: **it is five edits in four repos-worth of code.**
That is the price of a control plane that answers in 200 ms with the brain
mid-turn, and of a cloud that can never be talked into an op the house didn't
declare.

```
phone → POST /api/plugins/<id>/control ──▶ Worker: validate + REBUILD args
                                             │  (never a pass-through)
                                             ▼ control frame down the link
                                          bridge: validate AGAIN, rebuild
                                             ▼ HTTP
                                          your service
```

1. **Bridge — roster + probe** (`packages/bridge/src/index.ts`)
   - probe your service's `/health` on a timer; keep an `online` flag and a
     cached state object
   - add an entry to `pluginRoster()`, and push `plugins` / `plugin_state`
     up-frames when either changes (the cloud never guesses what a house has)
   - **the roster id is not automatically your folder name.** The `lighting`
     plugin exposes the control-plane plugin `lights`; the tile lookup reads
     `plugins/<folder>/plugin.json`, so a mismatched id silently costs your
     plugin its color. Add the pair to `TILE_MANIFEST_DIR` when they differ
     (TNGC-58 shipped grey once for exactly this).
2. **Contract** (`packages/contract/src/index.ts`) — extend `PluginStatus` /
   the frame types only if your plugin needs a shape the existing ones can't
   carry. Additive and optional, so an older bridge still rosters.
3. **Worker** (`apps/tricorder/src/worker.ts`) — `GET /api/plugins/<id>/state`
   and `POST /api/plugins/<id>/control`. Non-negotiable rules, all visible in
   the `lights` and `claudeops` handlers:
   - gate on `pluginEnabled(tenant, id)` — the household switch, not a global
   - gate on role. **Guests never reach a plugin** (the identity is shared, so
     attribution is impossible). Anything that can touch the host — like
     `claudeops`, which drives a `--dangerously-skip-permissions` session —
     is **admin only on read as well as write**, because the state payload is
     itself sensitive.
   - **validate and REBUILD every arg.** Free-form JSON must never ride a
     control frame; construct a fresh object from checked primitives.
   - log accepted ops to `control_log` with the caller's handle (`who turned
     the house dark`), best-effort, never blocking the response, pruning past
     retention in the same stroke.
4. **PWA** (`apps/tricorder/public/index.html`) — a `view-<id>` screen, an
   `open<Id>()` opener wired in `openPlugins()`'s tap handler, a poll while
   the screen is open and stopped in `logout()`. Render **reported** state
   (the bridge re-reads after each op); a tap gets optimistic paint only until
   the next poll.
5. **Manifest** — the `ui` block from step 1 gives the tile its color and
   glyph. Nothing else about the grid is yours to edit.

Enablement is per household and per plugin: the admin's **Enable plugins**
sheet writes `tenant_plugins`, and every endpoint above checks it. A plugin
that exists, is online, and is switched off is invisible — that is the switch
working.

### Which restart applies to what

The single most common "I shipped it and nothing changed":

| You changed | It takes effect on |
|---|---|
| Plugin manifest, MCP server, bridge, skills | **`make computer`** — the session spawns MCP servers and the bridge at launch and holds their schemas/reads |
| Your sidecar service | restart that container alone |
| Worker routes, cloud plugin, PWA | `wrangler deploy`, then **reload the PWA** |
| Anything in `packages/panel-renderer` | `pnpm -C apps/tricorder build:vs` **and then** deploy — see [adding-new-panels.md](adding-new-panels.md) |

## Step 8 — the verification battery

Run ALL of these before calling it landed (lighting's exact drills, in
order — every one caught something at least once):

```bash
# 1. compose config parses with the chain
docker compose -f compose.yaml -f plugins/<id>/compose.yaml config --quiet

# 2. sidecars come up WITHOUT touching a running stack
docker compose -f compose.yaml -f plugins/<id>/compose.yaml up -d --no-deps <sidecars...>
docker logs <each>   # startup clean? connected to its hardware/upstream?

# 3. service contract
#    /health → { ok:true } ; /state → sane ; error paths → clean {error}

# 4. panel passes the real validator (step 4 drill)

# 5. MCP protocol round-trip (pipe JSON-RPC lines through the real server
#    from inside the network — initialize, tools/list, tools/call happy +
#    error paths)
docker compose exec -T stack bash -c 'printf "%s\n" \
  "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"drill\",\"version\":\"0\"}}}" \
  "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}" \
  | node /home/node/tng-computer/plugins/<id>/mcp/server.mjs'

# 6. loader drill — enabled merges, disabled leaves ZERO trace
docker run --rm -u root --entrypoint bash -v "$PWD":/repo:ro \
  -e TNG_PLUGINS=<id> tng-computer-session -c '
  cp -r /repo/claude /tmp/claude
  bash /repo/docker/plugin-merge.sh /repo/plugins /tmp/claude
  jq ".mcpServers | keys" /tmp/claude/.mcp.json
  ls /tmp/claude/.claude/skills | grep plugin- ; cat /etc/tng/internal-endpoints.txt
  TNG_PLUGINS= bash /repo/docker/plugin-merge.sh /repo/plugins /tmp/claude
  jq ".mcpServers | keys" /tmp/claude/.mcp.json          # back to core only
  ls /tmp/claude/.claude/skills | grep plugin- || echo CLEAN'

# 7. failure drills — the difference between a demo and an appliance:
#    kill the broker/upstream → /health ok:false, tool says the offline
#    sentence; restart it → everything self-heals, cache re-warms
docker stop <broker> ; ...verify... ; docker start <broker> ; ...verify...

# 8. doctor
docker compose exec -T -e TNG_PLUGINS=<id> \
  -e TNG_PLUGINS_DIR=/home/node/tng-computer/plugins stack \
  bash -c 'cd /home/node/tng-computer && node docker/tng-cli.mjs doctor'

# 9. service restart amnesia — restart YOUR service alone; /state must
#    re-warm itself (retained topics + your probe), not report empty/off

# 10. tricorder face (only if you built step 7) — the tile lookup is the
#     trap: assert every id your roster can EMIT resolves a real manifest,
#     not just that the manifest you hand the parser is valid.
docker compose exec -T -w /home/node/tng-computer/packages/bridge stack \
  npx tsx -e 'import {pluginTile} from "./src/index.js";
    for (const id of ["lights","<your roster id>"])
      console.log(id, pluginTile(id) ?? "NO TILE — check TILE_MANIFEST_DIR")'
#     then, against a local worker: guest → 403, member → 403 if admin-only,
#     enabled=false → 403, and a control op with junk args → 400 (never a
#     pass-through to your service)
```

Then the live pass: `TNG_PLUGINS=<id> make computer`, check the boot banner
(`[plugins] <id> vX.Y.Z — mcp: …, skills: …, fence: …, ui ✓` — `ui MISSING`
means the tile will be grey), drive the tool by
voice, watch the panel refresh in place — and verify **physical reality
matches reported state**, not just that commands return 200 (see: optimistic
upstreams). If you built a tricorder face, open the plugin grid on a phone and
confirm your tile carries **your** color, not the grey fallback.

## Step 9 — enabling & shipping

- **Dev**: `TNG_PLUGINS=<id> make dev` + `TNG_PLUGINS=<id> make computer`
  (comma-separate multiple ids).
- **Appliance**: plugin folder into the `tng-plugins` volume,
  `TNG_PLUGINS=<id>` in `.env`, plugin compose file appended to
  `COMPOSE_FILE`, service image built on the host. Document the exact steps
  in your plugin README.
- Plugin code is committed to the main repo like everything else —
  **enablement** is what's per-household, not presence. Anything truly
  private to one household (addresses, device inventories beyond defaults)
  stays in env/volumes, not the repo.
- Ops changes on a live fabric (pairing hardware, renaming entities, forming
  groups) are **cards on the household board, not commits** — code defines
  capability; volumes hold reality.

## Reference — one exemplar per kind

**`plugins/lighting/` — the sidecar plugin, and the exemplar for steps 1–8.**
Sidecar first-boot seeding (zigbee2mqtt config), state mirroring + startup
probes, panel with visibility-marker refresh, zero-dep MCP server, routing
skill, scenes/effects with server-side conflict resolution, a tricorder face
with a full control screen, and a README whose naming contract survived a
hardware scale-out. When in doubt, do what lighting does.

**`plugins/claudeops/` — the host-service plugin.** No sidecars of its own:
the agent runs on the HOST (launched from the `claude_ops` repo), and the
manifest's entire job is declaring the pinpoint hole to
`host.docker.internal:7102` plus the env flag that tells the bridge the
plugin exists. Read it when your capability can't live inside a fence. It is
also the reference for an **admin-only** face — read *and* write — because
its state payload exposes a skip-permissions session.

**`calendar` (TNGC-52) — the cloud-native plugin.** No folder in `plugins/`
at all: routes in `apps/tricorder/src/calendar.ts`, a D1 migration, an entry
in `CLOUD_PLUGINS`, PWA screens, three wall panels in `panel-renderer`, and a
`calendar` MCP tool in `packages/console-mcp` that reaches the cloud with the
service token. Read it when the capability is household *data* — it keeps
working with the Computer unplugged, which is the whole reason the kind
exists.

**Two traps that have already cost a shipped release** (don't relearn them):
a roster id that isn't the plugin folder name silently greys your tile
(step 7.1), and a `panel-renderer` change that isn't followed by
`build:vs` + deploy works on the wall while every phone in Viewscreen mode
draws a "not yet installed" stub
([adding-new-panels.md](adding-new-panels.md) step 6).
