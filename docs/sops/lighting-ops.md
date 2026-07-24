# Lighting ops — pairing, naming, zones, control, recovery

Operating the **live Zigbee lighting fabric** (plugin: `plugins/lighting/`,
built by TNGC-9). This is the run-book for adding bulbs, forming zones, and
un-sticking lights — everything field-proven during the first 8-bulb
rollout on 2026-07-23. For *building/changing the plugin itself*, see
[adding-plugins.md](adding-plugins.md). Hardware scale-out phases live on
the **HSHLD-1** card — ops changes (pairing, renames, groups) are **card
notes, not commits**: code defines capability, volumes hold reality.

## The fabric at a glance

| Thing | Value |
|---|---|
| Coordinator | SMLIGHT SLZB-06U @ `10.0.0.15` (Ethernet mode, socket `:6638`, web UI `http://10.0.0.15`) |
| Zigbee channel | **25 — never change it** (a change force-re-pairs every device; chosen once, above US WiFi 1–11, because the Xfinity gateway channel-hops) |
| Zigbee2MQTT frontend | `http://localhost:8092` (host loopback; pairing + ops escape hatch) |
| Lighting service | `lighting:7101` (compose network only — reach it via `docker exec tng-computer-lighting-1 node -e 'fetch(...)'`) |
| Sidecars | `tng-computer-{mosquitto,zigbee2mqtt,lighting}-1`, state in volumes `lighting-mosquitto-data` / `lighting-z2m-data` |
| Enable | `TNG_PLUGINS=lighting make dev` / `make computer` |
| Bulbs | ThirdReality ZL1 (`3RCB01057Z`): RGB + 2700–6500 K, 800 lm, Zigbee router. Factory reset = toggle wall power 6× |

Zone map as of 2026-07-23 (verify live before trusting): `living-room` (4:
`fan-1..4`, TV-room fan) · `ariels-studio` (2: `dome-1..2`, ceiling dome) ·
`office` (2: `dome-1`, `lamp`) · `all-lights` (everything).

## Naming contract (do not improvise)

- Fixture: **`room/fixture`**, lowercase-hyphenated: `living-room/fan-3`,
  `office/lamp`, `primary-bedroom/lamp-left`. Identical bulbs in one
  fixture get numbered (`fan-1..4`, `dome-1..2`); a singular distinct
  fixture can be purpose-named (`lamp`).
- Zone = **native Zigbee group named exactly the room** (`office`), plus
  the house-wide **`all-lights`** group. Every bulb joins BOTH its room
  group and `all-lights`.
- Why groups matter: a zone command is ONE radio broadcast — in-sync
  fades, no popcorn, no mesh flood. Target resolution, the wall panel's
  room sections, and `target:"all"` all key off this contract.
- Spoken names normalize fine ("Ariel's Studio" → `ariels-studio`) —
  punctuation is stripped by the service.

## Adding bulbs / a new zone (the checklist)

1. **Open pairing** (≤2 min window): Z2M frontend `localhost:8092` →
   *Permit join*, or:
   ```bash
   docker exec tng-computer-lighting-1 node -e \
     'await fetch("http://localhost:7101/permit_join",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({time:120})})'
   ```
   (Deliberately not a `lights` tool action — opening the mesh is a human
   decision.)
2. **Power the bulbs on.** Factory-new ZL1s join on their own; used ones
   need the 6× power-toggle reset. They appear as `0x…` IEEE names.
3. **Find them:**
   ```bash
   docker exec tng-computer-lighting-1 node -e \
     'const s=await (await fetch("http://localhost:7101/state")).json(); for (const d of s.devices) if (d.name.startsWith("0x")) console.log(d.name, d.model)'
   ```
4. **Rename + group** — MQTT bridge requests via the broker container
   (~1 s between publishes; watch `docker logs tng-computer-zigbee2mqtt-1`
   for `"status":"ok"` responses):
   ```bash
   M="docker exec tng-computer-mosquitto-1 mosquitto_pub -h localhost -t"
   $M zigbee2mqtt/bridge/request/device/rename -m '{"from":"0x…","to":"office/dome-1"}'
   $M zigbee2mqtt/bridge/request/group/add    -m '{"friendly_name":"office"}'      # new rooms only
   $M zigbee2mqtt/bridge/request/group/members/add -m '{"group":"office","device":"office/dome-1"}'
   $M zigbee2mqtt/bridge/request/group/members/add -m '{"group":"all-lights","device":"office/dome-1"}'
   ```
5. **Verify with one zone command**, then check *reported* state — never
   trust the 200 alone:
   ```bash
   docker exec tng-computer-lighting-1 node -e '
   await fetch("http://localhost:7101/set",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({target:"office",brightness:80,colorTemp:"neutral"})});
   await new Promise(r=>setTimeout(r,3500));
   const s=await (await fetch("http://localhost:7101/state")).json();
   for (const d of s.devices) if (d.name.startsWith("office")) console.log(d.name, d.on?"ON":"off", d.brightnessPct+"%", d.color?.label, "LQI", d.linkQuality);
   console.log("radio errors:", s.radio.recentErrors)'
   ```
   Want: every fixture ON at the commanded level, `radio errors: 0`, sane
   LQI (200s = near coordinator; 30–80 = far/through walls, fine; watch
   repeat offenders).
6. Pairing auto-closes; the wall panel picks the new zone up **by itself**
   (in-place refresh). **Log the ops on HSHLD-1** (zone map delta, LQI
   notes). Done — voice works immediately, no session restart needed.

## Driving the lights

One tool: `lights {action, target?, scene?, brightness?, colorTemp?,
color?, transition?, effect?}` → service `POST /set` / `/scene`.

- Targets: zone (`office`), fixture (`office/lamp`), bare unambiguous
  fixture (`lamp`), or `all` (default) — groups resolve before devices.
- `brightness` 0–100 %, `colorTemp` kelvin or `warm|neutral|cool`,
  `color` name/`#rrggbb`, `transition` seconds (default 1.5).
- Scenes: `evening` 40 % warm · `movie` 12 % warm · `all-off` ·
  `red-alert` 100 % red · `party` 80 % + colorloop · **`reset` (see
  recovery)**. Scene names are plain strings → new scenes need **no MCP
  schema change** and work with a running session immediately.
- Effects (`action:"set"` + `effect`): `blink` `breathe` `okay`
  `channel_change` `finish_effect` `stop_effect` `colorloop`
  `stop_colorloop`. Effects always fan out **per device** under the hood.
- Semantics that surprise people: brightness-only changes do NOT stop a
  colorloop ("dim the party" keeps partying); any `color`/`colorTemp`
  command DOES (auto `stop_colorloop` first).

## Truth model — what to believe, when

Three layers of "state", each less trustworthy than the last:

1. **The bulb** (reality).
2. **Z2M/service cache** — fed by bulb reports and Z2M's *optimistic*
   group echoes. Drifts: color changes often aren't reported, optimistic
   echoes record what was *sent*, and an active effect (colorloop/strobe)
   is **invisible** to state entirely.
3. **A 200 from `/set`** — means the message reached MQTT, *nothing more*.
   Radio delivery can still fail (`MAC_NO_ACK`), especially directed
   commands under mesh load.

Consequences, wired into the plugin:

- `status` (cached, instant) is fine for questions and relative changes.
- **The wall panel truth-reads every reachable bulb (~2 s) before
  rendering** — showing the panel doubles as the re-sync when someone
  doubts the cache. Script equivalent: `GET /state?fresh=1`.
- The service tails Z2M's error log; **a WARNING in `status` means recent
  commands may not have reached the bulbs no matter what the state
  claims.** Never claim success the room contradicts.
- After a service restart, startup probes re-warm the cache in ~1 s
  (states aren't broker-retained).

## Recovery — stuck / strobing / possessed lights

**`lights action:"scene" scene:"reset" target:<room>`** — the panic
button. Sequence: group OFF → 4 s dark (mesh drains; directed commands
start ACKing again) → per-bulb `stop_effect` + `stop_colorloop` → settle →
group ON 70 % neutral → **verify each bulb reports ON, retry stragglers
individually** → honest per-fixture outcome. Warn the human about the ~5 s
blackout first. Field history: a strobing TV room survived correct stop
commands for minutes because every one died `MAC_NO_ACK` while the tool
said "Done" — the dark-gap + per-device + verify shape exists because of
that night.

Other recovery facts:

- **Wall switch off = bulb completely dead to the mesh** (no ACKs, not
  even reads). If a "fixture" won't respond at all, ask whether the switch
  is on before debugging radio. (Router plugs — HSHLD-1 Phase 1 — exist
  because bulbs also stop *routing* when switched off.)
- Z2M frontend (`localhost:8092`) is the ops escape hatch: per-device
  state, manual control, effect dropdown, renames, group editing, network
  map.
- Deep diagnosis: `docker logs tng-computer-zigbee2mqtt-1 | grep -iE
  "error|MAC_NO_ACK"` — the service's `/state` `.radio` field carries the
  last error and a 60 s set-failure count.
- After changing the plugin's MCP schema: the running session keeps the
  old tool schema until `TNG_PLUGINS=lighting make computer`. Design
  around it (scene names beat new parameters); say so at handoff.

## When the next 8 bulbs arrive

Per room: pair (checklist above) → number fixtures within each fitting →
new room group + `all-lights` membership → one-command zone verify → log
on HSHLD-1. Rooms with >2 bulbs make group-vs-fanout visible: confirm the
zone fades in sync (group broadcast working). Once the router-plug
backbone (HSHLD-1 Phase 1) is in, re-check LQI on the far bulbs — they
should route through the plugs. The wall panel auto-collapses to per-room
summaries past ~14 fixtures; nothing to do there.
