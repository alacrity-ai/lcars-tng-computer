# Lighting plugin

Local Zigbee lighting for the TNG Computer — the **reference plugin**
(TNGC-9). No vendor hub, no cloud, no per-bulb WiFi: an Ethernet Zigbee
coordinator, two sidecars, and one MCP tool.

```
Claude session ── lights MCP (in-fence) ──HTTP──> lighting service :7101
                                                      │ MQTT
 wall ◄── LIGHTING composite panel ── lighting ── Mosquitto ── Zigbee2MQTT ──tcp──> SLZB-06U ── Zigbee mesh
```

- **mosquitto** — MQTT broker, compose-network only.
- **zigbee2mqtt** — drives the mesh through an SMLIGHT SLZB-06U (or any
  zstack coordinator) over TCP. Pairing/ops frontend on host loopback
  **:8092**.
- **lighting** — mirrors retained fabric state into a cache (status answers
  never probe the mesh), exposes HTTP `:7101` for the `lights` tool
  (`/health`, `/state`, `/set`, `/scene`, `/panel`, `/permit_join`), and
  composes the LIGHTING wall panel — refreshed in place on state change
  only while it's actually on screen.

## Enabling

Dev: `TNG_PLUGINS=lighting make dev` and `TNG_PLUGINS=lighting make computer`.
Appliance: plugin folder in the `tng-plugins` volume, `TNG_PLUGINS=lighting`
in `.env`, this `compose.yaml` added to `COMPOSE_FILE`, and the `lighting`
service image built from `service/` on the host.

Configuration (env, all optional):

| Var | Default | What |
|---|---|---|
| `LIGHTING_SLZB_ENDPOINT` | `tcp://10.0.0.15:6638` | Coordinator's Zigbee socket |
| `TZ` | `America/New_York` | Zigbee2MQTT log timestamps |

**Zigbee channel 25 is set at network formation and is effectively
permanent** — changing it forces a full re-pair of every device. It was
chosen once, deliberately above the US WiFi 1–11 band, because consumer
gateways (Xfinity) hide and auto-hop their 2.4 GHz channel. Same for the
coordinator's physical spot: mount it in its final location BEFORE pairing
anything.

## Pairing a device

1. Open the Zigbee2MQTT frontend — `http://localhost:8092` — and press
   **Permit join**, or:
   `curl -X POST http://lighting:7101/permit_join -d '{"time":120}'`
   (from inside the compose network; deliberately not exposed via the
   `lights` tool — opening the mesh is a human decision).
2. Power the device on (a factory-new bulb starts searching; a used one
   needs a reset — ThirdReality ZL1: toggle power 6×).
3. It appears in the frontend — **rename it immediately** to the canonical
   `room/fixture` name (below).
4. Permit join closes on its own; verify with
   `lights action:"status"` and drive it: on/off, brightness, colorTemp,
   color, transition.

## Naming + groups — the HSHLD-1 scale-out contract

- **Fixtures:** `room/fixture` — `living-room/ceiling`, `kitchen/counter-1`,
  `primary-bedroom/lamp-left`. Lowercase, hyphenated, the room is the
  segment before the slash. The wall panel and target resolution both key
  off this shape.
- **Zones:** one **native Zigbee group per room**, named exactly the room
  (`living-room`, `kitchen`) — created in the Z2M frontend (Groups → add,
  then add each fixture). Group commands are ONE radio broadcast per zone:
  in-sync fades, no popcorn effect, no mesh flood. Until a room has a
  group, the service falls back to fanning out per fixture — works, but
  form the groups as rooms grow past a bulb or two.
- **House:** an optional `all-lights` group; `target:"all"` uses it when it
  exists, otherwise every zone.
- **Scenes** (server-side, in `service/src/control.mjs`): `evening` (40%
  warm), `movie` (12% warm), `all-off`, `red-alert` (100% red), `party`
  (80% + colorloop — exit with effect `stop_colorloop`). Scenes take an
  optional `target` to scope to a zone. `/set` also takes `effect` — the
  Zigbee identify/color-loop effects (`blink`, `breathe`, `okay`,
  `channel_change`, `finish_effect`, `stop_effect`, `colorloop`,
  `stop_colorloop`).

## Troubleshooting

- `tng doctor` (with `TNG_PLUGINS=lighting`) checks the manifest and
  `lighting:7101/health`; the boot banner lists the plugin's tool + skill.
- `/health` says `ok:false` with `bridge:"offline"` → Zigbee2MQTT isn't
  connected to the broker or the coordinator: `docker compose logs
  zigbee2mqtt`. Coordinator unreachable → check `tcp://<ip>:6638` from the
  LAN and that nothing else (another Z2M?) is holding the socket.
- MQTT down mid-flight → the tool answers "Lighting control is offline."
  and the service reconnects on its own when the broker returns.
- First-boot config is seeded by `compose.yaml` into the `lighting-z2m-data`
  volume; after that **Zigbee2MQTT owns `configuration.yaml`** (edit via its
  frontend). To re-seed from scratch (destroys the network + all pairings):
  `docker volume rm <project>_lighting-z2m-data`.
