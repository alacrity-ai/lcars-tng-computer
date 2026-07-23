# Plugins

Optional capability, explicitly enabled per install — never shipped default.
Full design: [`docs/PLUGIN_SYSTEM_DESIGN.md`](../docs/PLUGIN_SYSTEM_DESIGN.md).

A plugin is a folder:

```
plugins/<id>/
  plugin.json          # manifest (JSON — the loader is bash+jq)
  compose.yaml         # sidecar services (optional)
  service/             # plugin backend — its own container (optional)
  mcp/                 # MCP server, runs inside the fenced computer container (optional)
  skills/              # skill dirs, merged at boot as plugin-<id>-<name> (optional)
  README.md            # what it needs, how to enable it
```

## plugin.json

```json
{
  "id": "lighting",
  "name": "Zigbee Lighting",
  "version": "0.1.0",
  "minCore": "0.3.0",
  "description": "Local Zigbee lighting fabric",
  "services": [
    { "name": "lighting", "internalEndpoints": [{ "host": "lighting", "port": 7101 }] }
  ],
  "mcp": { "name": "lights", "command": "pnpm", "args": ["-C", "/opt/tng/plugins/lighting/mcp", "start"] },
  "skills": ["lighting"],
  "allowedDomains": []
}
```

- `internalEndpoints` — pinpoint `host:port` holes the fenced brain gets to
  this plugin's sidecars. Nothing else opens.
- `allowedDomains` — EXTERNAL egress for the brain. Empty for anything fully
  local; every entry is printed at boot.

## Enabling

- **Dev:** `TNG_PLUGINS=lighting make dev` / `make computer` — the Makefile
  chains `plugins/<id>/compose.yaml`, the container entrypoint merges MCP,
  skills, and fence entries at boot.
- **Appliance:** drop the folder in the `tng-plugins` volume, then in `.env`:
  `TNG_PLUGINS=lighting` and add the plugin's compose file to `COMPOSE_FILE`
  (see the plugin's README). `docker compose up -d`.

## Sidecar lifecycle

Your `compose.yaml` should attach its services to the core lifecycle by
extending the existing services with `depends_on`, so `up stack` starts your
sidecars and the fence can resolve them when the brain boots:

```yaml
services:
  mosquitto: { ... }
  lighting:  { ... }
  stack:
    depends_on: [lighting]
  computer:
    depends_on: [lighting]
```

## Wall panels

Plugins render on the wall through the **composite panel** — POST
`{"view":"composite","props":{...}}` to the server's
`/api/console/display` from your service (see the design doc §3 for the
block language and limits). No plugin code ever executes in the wall.
