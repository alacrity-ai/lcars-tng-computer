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
  "ui": {
    "color": "#ff9900",
    "icon": { "viewBox": "0 0 24 24", "paths": ["M9 18h6", "M10 21h4", "M12 2a7 7 0 0 0-4 12.8V18h8v-3.2A7 7 0 0 0 12 2z"] }
  },
  "services": [
    { "name": "lighting", "internalEndpoints": [{ "host": "lighting", "port": 7101 }] }
  ],
  "mcp": { "name": "lights", "command": "node", "args": ["../plugins/lighting/mcp/server.mjs"] },
  "skills": ["lighting"],
  "allowedDomains": []
}
```

- `ui` — **required.** The plugin's square tile on the tricorder's plugin
  grid: `color` (`#rrggbb`) behind `icon` (SVG path **data**, drawn by the
  phone — never markup it renders). Core hardcodes no plugin's look. Missing
  or invalid drops to a grey generic tile and says so at boot; it never
  disables the plugin. Full rules:
  [docs/sops/adding-plugins.md](../docs/sops/adding-plugins.md).
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
