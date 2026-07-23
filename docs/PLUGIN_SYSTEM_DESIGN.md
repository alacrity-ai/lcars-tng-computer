# Plugin / Extension System — Implementation Design (TNGC-33)

**Status: final design, 2026-07-24.** Companion ticket: TNGC-33 (core system),
TNGC-9 (reframed: the lighting plugin, the reference implementation).

## 1. Why this exists

The distribution era (TNGC-28…31) split the world into *the product* (immutable
images every household pulls) and *a house* (one installation's hardware,
services, and quirks). Lighting (TNGC-9) is the first feature that lands on the
wrong side of that line: it needs a custom wall panel, a control-plane MCP
surface, **and server-side sidecar processes** (Mosquitto + Zigbee2MQTT) that
only exist in houses that bought a Zigbee coordinator. Welding it into
`apps/server` would ship every household a dead MQTT client, a panel that
renders nothing, tools that fail when called, and persona text that routes
"turn off the lights" into an error.

A **plugin** is an optional capability a household explicitly enables. It can
contribute, in any combination:

1. **Sidecar containers** (brokers, bridges, device daemons)
2. **An MCP control plane** (tools the Computer calls)
3. **Skills** (voice routing + procedure)
4. **Wall panels** (via the composite panel — §3)
5. **Egress additions** (fence allowlist entries, loudly declared)

Design tenets, inherited from decisions already settled in this repo:

- **Core stays generic.** `apps/server`, `apps/web`, `packages/*` contain no
  house-specific code. The plugin system is mostly *conventions + boot-time
  merging*, not new runtime machinery.
- **Disabled by default, enabled explicitly.** Enabling a plugin is a human
  decision per install (`TNG_PLUGINS`), never a shipped default.
- **State is born inside its boundary.** Plugin volumes, configs, and paired
  device databases live under the plugin's name from day one — no adopted pet
  infrastructure (the learned-knowledge-volume lesson).
- **The fence stays honest.** The brain's default-deny egress is only widened
  by entries the enabled plugin declares, applied at boot where the human can
  see them.

## 2. The wall-panel decision: JSON panel language, not lazy-loaded bundles

The one genuinely hard extension point. Two candidates were considered
seriously:

**(A) A declarative JSON panel schema** — plugins (and anything else) describe
panels as a tree of LCARS primitives; the wall ships ONE new renderer
(`composite`) that renders any such tree.

**(B) Lazy-loaded JS bundles** — plugins ship compiled React components; the
wall dynamically imports them at runtime (module-federation style).

**Decision: (A), the JSON schema.** Reasons, in order of weight:

1. **The Computer is already a JSON-panel author.** Every existing panel is
   `view + props JSON` composed by the model. A declarative panel language is
   not a new dialect bolted on for plugins — it is the same contract, one view
   deeper. The moment `composite` exists, the model itself can build ad-hoc
   dashboards by voice ("give me a dashboard of the aquarium sensors")
   with zero plugin involved. Option B is opaque to the model; option A makes
   panel composition a first-class capability of the whole system. This is
   the argument unique to us, and it is decisive.
2. **Security.** The wall is a browser on the household LAN. A plugin JS
   bundle executes with full DOM + `fetch` in that context — a malicious or
   compromised plugin becomes a LAN-resident script in the living room. A
   JSON tree is inert data rendered by trusted primitives (`textContent`
   everywhere, no HTML pass-through, assets by same-origin reference only).
3. **Version stability.** Appliance walls update via image tags. Compiled
   bundles couple to the wall's React version and build internals — version
   skew after an image update breaks strangers' houses silently. A schema is
   versioned additively, exactly like the cloud contract (unknown block types
   render as a labeled placeholder, never a crash).
4. **Aesthetic coherence.** The primitives ARE the LCARS design system.
   Twenty plugins by twenty authors still look like one Computer.
5. **Bounded effort.** The renderer is one well-scoped component over CSS that
   largely exists. Module federation is permanent infrastructure with sharp
   edges (shared-dependency negotiation, CSP, cache busting).

**Accepted ceiling:** truly bespoke interactive panels (the maps/night-sky
class) cannot be expressed in the schema. That is deliberate. The escape
hatches, in order: the `svg` primitive with by-reference assets (the proven
svgAsset pattern — covers most "custom visualization" needs); and for real
interactivity, **contributing the panel to core** via PR, where it gets
reviewed and ships to everyone. Runtime code injection into the wall is
rejected permanently, not deferred.

## 3. The composite panel (schema v1)

New core view `composite` (all layers: shared types, web renderer, console-mcp
display schema, history/recall, library save as family `data`, PWA renderer
fallback = placard).

```jsonc
{
  "title": "LIGHTING",              // wall header line + history summary
  "accent": "gold",                  // gold|peach|lav|blue|red (default gold)
  "columns": 2,                      // 1..3; wall may collapse when cramped
  "blocks": [ /* Block[] */ ]
}
```

**Block types (v1):**

| type | fields | renders as |
|---|---|---|
| `group` | `title`, `accent?`, `items: Block[]` | LCARS section: color cap + title bar + contents |
| `readout` | `label`, `value`, `unit?`, `accent?` | Okudagram data pair, tabular numerals |
| `status` | `label`, `state: on\|off\|warn\|alert\|idle`, `detail?` | color block chip (state → color) |
| `gauge` | `label`, `value: 0..1`, `text?`, `accent?` | horizontal LCARS bar with fill |
| `text` | `body`, `role?: body\|caption` | prose (same rules as text panel) |
| `list` | `items: {label, detail?, accent?}[]` | fam-bar rows (library-list style) |
| `keyvalue` | `pairs: {k, v}[]` | two-column table |
| `sparkline` | `label`, `points: number[]`, `unit?` | small trend line (SVG, generated by renderer) |
| `svg` | `assetUrl` (same-origin path only), `caption?` | by-reference vector (svgAsset pattern) |
| `divider` | — | thin rule |

**Hard constraints (validated server-side in the display route, and mirrored
in shared types):** max depth 3, max 64 blocks total, max 16 KB props, strings
rendered via `textContent` only, `svg.assetUrl` must be same-origin path.
Unknown block types render as a small "UNSUPPORTED BLOCK <type>" placard —
additive evolution, never a crash. Sizing follows the text panel's philosophy:
auto-fit with a readability floor, then scroll; authors should cut, not shrink.

**Liveness:** a plugin (or the server) re-broadcasts the same `view:
"composite"` with updated props; the wall updates in place (the panel-wipe key
is the view name, so same-view refreshes don't re-run the wipe — the status
board already behaves this way). Server rate-limits composite broadcasts
(≥500 ms apart) so a chatty plugin cannot strobe the wall.

**No `button`/action blocks in v1.** The wall is a TV, not a touch surface;
voice is the control plane, and controls flow through the plugin's MCP tools.
An action model (for a future touch wall or the tricorder rendering
composites) is a v2 item and must be designed with an authorization story —
explicitly out of scope now.

**Model authorship:** a new core skill `composite` teaches the Computer to
build ad-hoc dashboards with these primitives (when no dedicated panel fits).
This falls out of the architecture for free and ships with v0.

## 4. Plugin anatomy

```
plugins/<id>/
  plugin.yaml            # the manifest (below)
  compose.yaml           # sidecar services (optional)
  service/               # the plugin's backend, if any — its own container
  mcp/                   # MCP server package, run INSIDE the computer container (optional)
  skills/                # skill dirs, merged into claude/.claude/skills at boot (optional)
  allowed-domains.txt    # extra EXTERNAL egress for the brain (optional, discouraged)
  README.md              # what it is, what hardware it needs, how to enable
```

**`plugin.yaml`:**

```yaml
id: lighting
name: Zigbee Lighting
version: 0.1.0
minCore: "0.3.0"            # refuse to load on older images
description: Local Zigbee lighting fabric (Zigbee2MQTT + Mosquitto)
services:                    # sidecars, for doctor + fence wiring
  - name: lighting           # compose service name
    internalEndpoints:       # brain→service holes to punch in the fence
      - host: lighting
        port: 7101
mcp:
  name: lights               # registered as mcpServers["lights"]
  command: pnpm
  args: ["-C", "/opt/tng/plugins/lighting/mcp", "start"]
skills: [lighting]
allowedDomains: []           # external egress — empty for lighting (fully local)
```

**Where plugins live:** dev = `plugins/` in the repo (bind-mounted like
everything else; first-party plugins are developed here and are PUBLIC — a
plugin that must stay private lives in a separate repo cloned into
`plugins/`). Appliance = the `tng-plugins` volume; installing = dropping the
plugin folder there (v0: `docker cp` / a curl-tarball one-liner in the
plugin's README; a `tng plugin install <url>` command is later polish).

**Enablement:** `TNG_PLUGINS=lighting,other` env on BOTH containers (absent =
none — strangers' installs are unaffected by anything in this design).
Sidecars enable via compose file chaining, which docker compose supports
natively through `.env`:

```
# appliance .env
TNG_PLUGINS=lighting
COMPOSE_FILE=docker-compose.yml:plugins/lighting/compose.yaml
```

Dev mirrors this with a Makefile helper (`make dev` / `make computer` read
`TNG_PLUGINS` and assemble the `-f` chain). One mechanism, both modes.

## 5. Boot-time merging (the loader)

A shared `docker/plugin-merge.sh`, called by BOTH computer entrypoints (dev +
appliance) before dropping privileges. For each id in `TNG_PLUGINS`, from
`/opt/tng/plugins/<id>` (appliance) or the bind-mounted `plugins/<id>` (dev):

1. **MCP:** generate `claude/.mcp.json` = `.mcp.base.json` (the checked-in
   template — the current `.mcp.json` is renamed) + each plugin's `mcp` entry,
   via jq. `.mcp.json` becomes gitignored/generated. Disabled plugin → its
   entry simply isn't generated.
2. **Skills:** sync `plugins/<id>/skills/*` into `claude/.claude/skills/` under
   a namespaced dir (`plugin-<id>-<skill>`), same shipped-wins semantics as
   the persona seed merge; skills of no-longer-enabled plugins are removed
   (the namespace prefix makes this safe — household-authored skills are
   untouched).
3. **Fence:** append the plugin's `allowedDomains` to the merged allowlist
   (same mechanism as `TNG_EXTRA_ALLOWED_DOMAINS`), and resolve each
   `internalEndpoints` service name to its compose-network IP, allowing
   exactly `ip:port` — the brain gets a hole to the plugin service, not to the
   docker network at large and not to the LAN.
4. **Log the result loudly:** one boot banner line per plugin — id, version,
   mcp yes/no, skills count, fence additions. Silence is for disabled things.

**Persona routing needs no CLAUDE.md mutation:** skills surface by
description — the plugin's skill description IS its routing. (CLAUDE.md's
capability table remains a core-features convenience; plugins ride the skill
mechanism that already works.)

**Server/stack:** needs no plugin awareness at all. Plugin services reach the
wall exactly like the onboarding wizard does — POSTing to the server's console
API on the compose network (`display`, composite props). The `tng doctor`
gains a per-plugin section: manifest found, sidecars responding (`/health` on
each `internalEndpoints`), mcp registered.

## 6. Security model (explicit)

- **Sidecars are unfenced** — they are ordinary containers like the stack
  (unrestricted egress, no host secrets). The fence protects the *brain*;
  enabling a plugin means trusting its containers the way you trust the stack.
- **The brain's fence widens only by declaration:** external domains from
  `allowedDomains` (reviewable in the boot banner) + pinpoint internal
  `ip:port` holes. A plugin cannot silently open the LAN to the model.
- **The wall executes no plugin code, ever** (§2). Composite props are data;
  SVG assets are served by-reference from same-origin.
- **MCP servers run inside the fence** as children of the session (like
  console-mcp/bridge) — they inherit the brain's egress restrictions, which is
  exactly right: a plugin's tool surface should not be a tunnel out.
- Enabling = editing `.env` on the box — already the household-admin privilege
  boundary. No remote enable path exists, deliberately.

## 7. Reference implementation: the lighting plugin (reframed TNGC-9)

`plugins/lighting/` — proves all five extension points:

- **compose.yaml:** `mosquitto` (eclipse-mosquitto, volume
  `lighting-mosquitto-data`), `zigbee2mqtt` (koenkk/zigbee2mqtt, volume
  `lighting-z2m-data`, config: `port: tcp://<SLZB_IP>:6638`, `adapter:
  zstack`, **`channel: 25`**, `permit_join: false` at rest), `lighting`
  (the service).
- **service/:** small node app — MQTT client on mosquitto, mirrors
  `zigbee2mqtt/#` retained state into a cache; HTTP on `:7101` for the MCP
  server (`GET /state`, `POST /set {target, ...}`, `POST /scene`); composes
  the LIGHTING composite panel (rooms as `group` blocks, `status` +
  brightness `gauge` per fixture/group) and POSTs it to the wall on demand
  and on state change while it is the visible panel.
- **mcp/:** `lights` tool — `{action: on|off|set|scene|status|panel, target?,
  brightness?, colorTemp?, color?, transition?}` (one tool, verb param —
  TNGC-9's original shape survives intact), talking HTTP to the service.
- **skills/lighting/SKILL.md:** phrase → tool routing ("dim X to N%",
  "warm/cool", "movie mode", "are the kitchen lights on", "show me the
  lights"), group vocabulary from HSHLD-1's naming, MQTT-down behavior
  ("Lighting control is offline." — clean error, no hang).
- Group commands per room (one publish per zone), scenes server-side
  (`evening`, `movie`, `all-off`, `red-alert`), transitions default 1–2 s.

Hardware/provisioning phases stay on HSHLD-1 (coordinator ✓ done: SLZB-06U at
10.0.0.15, Ethernet mode, fw updated; test bulb pairs only after the plugin
exists, so pairing state is born inside `lighting-z2m-data`).

## 8. Build order

1. **Core:** composite panel (types → validator → wall renderer → console-mcp
   display schema → `composite` skill → tricorder FAMILY_BY_VIEW + PWA
   placard) — demoable alone ("Computer, make me a dashboard of…").
2. **Loader:** plugin.yaml convention, `plugin-merge.sh` in both entrypoints,
   `.mcp.base.json` rename, Makefile/compose chaining, doctor section.
3. **Lighting plugin** on top (TNGC-9), Phase-0 hardware already waiting.
4. Appliance docs: "Plugins" section in APPLIANCE.md + landing page note.

Non-goals for v0: plugin marketplace/registry, remote install, signed
manifests, composite action blocks, per-plugin resource limits. All noted,
none blocking.
