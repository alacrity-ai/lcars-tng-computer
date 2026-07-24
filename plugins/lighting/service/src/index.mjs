// TNG lighting plugin service (TNGC-9).
//
// One process, three jobs:
//   1. Mirror the fabric — subscribe zigbee2mqtt/# and cache retained state,
//      so every status question is answered from memory (no mesh probe).
//   2. HTTP :7101 for the lights MCP tool (the brain's only fence hole into
//      this plugin): /health /state /set /scene /panel /permit_join.
//   3. The LIGHTING wall panel — composed from cache, POSTed to the stack on
//      demand, refreshed in place on state change ONLY while it is visibly
//      on screen (checked via /api/console/screen — never yank the wall back).
import { createServer } from "node:http";
import mqtt from "mqtt";
import { composePanel, PANEL_TITLE } from "./panel.mjs";
import { buildCommand, knownNames, miredsToKelvin, normalize, resolveTargets, SCENES } from "./control.mjs";
import { currentColor } from "./color.mjs";

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://mosquitto:1883";
const STACK_URL = process.env.STACK_URL ?? "http://stack:3789";
const PORT = Number(process.env.PORT ?? 7101);
const BASE = process.env.BASE_TOPIC ?? "zigbee2mqtt";
const OFFLINE = "Lighting control is offline.";

const log = (m) => console.error(`[lighting] ${m}`);

// ---------------------------------------------------------------- fabric cache
const cache = {
  bridge: "offline", // zigbee2mqtt/bridge/state
  info: null, // bridge/info (channel, versions)
  devices: [], // bridge/devices minus the coordinator
  groups: [], // bridge/groups
  states: new Map(), // friendly name -> last reported state object
  availability: new Map(), // friendly name -> online|offline
  radioErrors: [], // recent zigbee2mqtt error-log lines (delivery failures)
};
let mqttConnected = false;
const startedAt = Date.now();

const client = mqtt.connect(MQTT_URL, { reconnectPeriod: 2000 });
client.on("connect", () => {
  mqttConnected = true;
  client.subscribe(`${BASE}/#`);
  probed.clear(); // broker may have restarted — cached states can be stale
  probeStates();
  log(`mqtt connected: ${MQTT_URL}`);
});

// Z2M does NOT retain device state topics, so a fresh service (or broker)
// start knows the roster (bridge/devices is retained) but not who's lit.
// Ask each unknown device once — Z2M answers on its state topic and the
// cache warms itself.
const probed = new Set();
function probeStates() {
  if (!mqttConnected) return;
  for (const d of cache.devices) {
    const name = d.friendly_name;
    if (!name || cache.states.has(name) || probed.has(name)) continue;
    probed.add(name);
    client.publish(`${BASE}/${name}/get`, JSON.stringify({ state: "" }));
  }
}
client.on("close", () => {
  mqttConnected = false;
});
client.on("error", (err) => log(`mqtt error: ${err.message}`));

client.on("message", (topic, buf) => {
  if (!topic.startsWith(`${BASE}/`)) return;
  const sub = topic.slice(BASE.length + 1);
  const text = buf.toString();
  const json = () => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  if (sub === "bridge/state") {
    cache.bridge = (json()?.state ?? text) === "online" ? "online" : "offline";
    scheduleRefresh();
    return;
  }
  if (sub === "bridge/info") {
    cache.info = json();
    return;
  }
  if (sub === "bridge/devices") {
    const list = json();
    if (Array.isArray(list)) cache.devices = list.filter((d) => d.type !== "Coordinator");
    probeStates();
    scheduleRefresh();
    return;
  }
  if (sub === "bridge/groups") {
    const list = json();
    if (Array.isArray(list)) cache.groups = list;
    return;
  }
  if (sub === "bridge/logging") {
    // Z2M reports radio-layer failures (MAC_NO_ACK etc.) here, NOT on the
    // command topic — without this, the tool claims success for commands
    // the mesh silently dropped (user-hit: unstoppable strobe).
    const p = json();
    if (p?.level === "error") {
      cache.radioErrors.push({ t: Date.now(), message: String(p.message ?? "").slice(0, 300) });
      if (cache.radioErrors.length > 20) cache.radioErrors.shift();
    }
    return;
  }
  if (sub.startsWith("bridge/")) return; // request/response chatter
  if (sub.endsWith("/availability")) {
    const name = sub.slice(0, -"/availability".length);
    cache.availability.set(name, (json()?.state ?? text) === "online" ? "online" : "offline");
    scheduleRefresh();
    return;
  }
  if (sub.endsWith("/set") || sub.endsWith("/get")) return;
  // Everything else is a device/group state topic (friendly names contain /).
  const p = json();
  if (p && typeof p === "object" && !Array.isArray(p)) {
    cache.states.set(sub, { ...(cache.states.get(sub) ?? {}), ...p });
    scheduleRefresh();
  }
});

// ------------------------------------------------------------------ wall panel
let panelActiveUntil = 0; // we posted the panel; it may still be on screen
let refreshTimer = null;
let lastPanelPost = 0;

function scheduleRefresh() {
  if (Date.now() > panelActiveUntil || refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    try {
      const res = await fetch(`${STACK_URL}/api/console/screen`, { signal: AbortSignal.timeout(3000) });
      const screen = await res.json();
      if (screen.view !== "composite" || screen.props?.title !== PANEL_TITLE) {
        panelActiveUntil = 0; // the wall moved on — stop shadowing it
        return;
      }
      await postPanel();
    } catch {
      /* stack unreachable — the next state change will try again */
    }
  }, 800);
}

async function postPanel() {
  // Stay under the server's composite rate limit (2/s) even when a burst of
  // MQTT updates lands, and retry once if the shared bucket still 429s.
  const wait = 600 - (Date.now() - lastPanelPost);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const body = JSON.stringify({ view: "composite", props: composePanel(cache, mqttConnected) });
  const post = () =>
    fetch(`${STACK_URL}/api/console/display`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(5000),
    });
  let res = await post();
  lastPanelPost = Date.now();
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 700));
    res = await post();
    lastPanelPost = Date.now();
  }
  if (res.ok) panelActiveUntil = Date.now() + 30 * 60 * 1000;
  return res;
}

// ------------------------------------------------------------------------ http
function stateSummary() {
  return {
    // The cache goes silently stale when the broker link drops — never
    // report a bridge we can't currently hear.
    bridge: mqttConnected ? cache.bridge : "offline",
    coordinator: cache.info
      ? {
          channel: cache.info.network?.channel,
          panId: cache.info.network?.pan_id,
          version: cache.info.version,
          coordinatorFirmware: cache.info.coordinator?.meta?.revision,
        }
      : null,
    devices: cache.devices.map((d) => {
      const s = cache.states.get(d.friendly_name) ?? {};
      return {
        name: d.friendly_name,
        model: d.definition?.model ?? d.model_id,
        available: cache.availability.get(d.friendly_name) !== "offline",
        on: s.state === "ON",
        brightnessPct: typeof s.brightness === "number" ? Math.round((s.brightness / 254) * 100) : null,
        colorTempK: typeof s.color_temp === "number" ? miredsToKelvin(s.color_temp) : null,
        colorMode: s.color_mode ?? null,
        // {hex, label} — label is the human name for it ("4000K", "#FF0000")
        color: currentColor(s),
        linkQuality: typeof s.linkquality === "number" ? s.linkquality : null,
      };
    }),
    groups: cache.groups.map((g) => ({
      name: g.friendly_name,
      members: (g.members ?? []).length,
    })),
    scenes: [...Object.keys(SCENES), "reset"],
    // Radio truth: Z2M-reported delivery failures in the last minute. When
    // this is non-empty, recent commands may NOT have reached the bulbs no
    // matter what the cache claims.
    radio: {
      // Only command ('set') failures drive the warning — 'get' failures are
      // usually startup probes against wall-switched-off bulbs, not trouble.
      recentErrors: recentRadioErrors().filter((e) => e.message.includes("Publish 'set'")).length,
      lastError: cache.radioErrors.at(-1)?.message ?? null,
    },
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 65536) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("body must be JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Group topic -> member device friendly names (falls back to the group). */
function deviceTopicsFor(topic) {
  const group = cache.groups.find((g) => g.friendly_name === topic);
  if (!group) return [topic];
  const byIeee = new Map(cache.devices.map((d) => [d.ieee_address, d.friendly_name]));
  const members = (group.members ?? []).map((m) => byIeee.get(m.ieee_address)).filter(Boolean);
  return members.length ? members : [topic];
}

function publishTo(targets, payload) {
  // Two hard-won rules live here:
  //  1. EFFECTS GO PER-DEVICE. Z2M's group effect path issues directed
  //     reads/commands against individual members anyway and fails half of
  //     them under load (MAC_NO_ACK) — fan the effect out ourselves.
  //  2. COLOR INTENT KILLS A LOOP FIRST. An active colorloop overrides
  //     color commands and Z2M optimistically reports the color you asked
  //     for. Deactivate is a no-op when nothing loops. Brightness-only
  //     changes deliberately keep the loop ("dim the party").
  const { effect, ...rest } = payload;
  const hasRest = Object.keys(rest).some((k) => k !== "transition");
  const colorIntent = (rest.color || rest.color_temp !== undefined) && !effect;
  for (const t of targets.topics) {
    const devices = colorIntent || effect ? deviceTopicsFor(t) : null;
    if (colorIntent) for (const d of devices) client.publish(`${BASE}/${d}/set`, JSON.stringify({ effect: "stop_colorloop" }));
    if (effect) for (const d of devices) client.publish(`${BASE}/${d}/set`, JSON.stringify({ effect }));
    // State/color/brightness stays a single group cast — those are reliable
    // and keep zones fading in sync.
    if (hasRest) client.publish(`${BASE}/${t}/set`, JSON.stringify(rest));
  }
}

function recentRadioErrors(windowMs = 60_000) {
  const cutoff = Date.now() - windowMs;
  return cache.radioErrors.filter((e) => e.t >= cutoff);
}

/**
 * Read ground truth off every reachable bulb and let it land in the cache.
 * Reporting gaps and Z2M's optimistic group echoes let the cache drift from
 * the actual bulbs (user-hit: panel showed stale levels after a run of
 * adjustments) — so anything user-facing that CLAIMS to be current calls
 * this first. Reads are fire-and-collect: publish /get to each device, then
 * give the answers a beat to arrive; wall-switched-off bulbs just miss the
 * window (their /get errors are filtered out of the radio warning).
 */
async function refreshTruth(timeoutMs = 2000) {
  if (!mqttConnected) return;
  const READ = JSON.stringify({ state: "", brightness: "", color_temp: "", color: { x: "", y: "" } });
  for (const d of cache.devices) {
    if (!d.friendly_name) continue;
    if (cache.availability.get(d.friendly_name) === "offline") continue;
    client.publish(`${BASE}/${d.friendly_name}/get`, READ);
  }
  await new Promise((r) => setTimeout(r, timeoutMs));
}

const server = createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  try {
    const url = new URL(req.url ?? "/", "http://lighting");
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /health") {
      return send(200, {
        ok: mqttConnected && cache.bridge === "online",
        mqtt: mqttConnected,
        bridge: cache.bridge,
        devices: cache.devices.length,
        radioErrorsLastMin: recentRadioErrors().length,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      });
    }
    if (route === "GET /state") {
      // ?fresh=1 → verified truth (reads every bulb, ~2s); default is the
      // instant cache — voice status stays snappy.
      if (url.searchParams.get("fresh")) await refreshTruth();
      return send(200, stateSummary());
    }
    if (route === "GET /panel/preview") return send(200, composePanel(cache, mqttConnected));
    if (req.method !== "POST") return send(404, { error: "unknown route" });

    const body = await readJson(req);

    if (route === "POST /set") {
      const targets = resolveTargets(cache, body.target);
      if (!targets) {
        const known = knownNames(cache);
        return send(404, {
          error: `no light, room, or group matches "${body.target ?? "all"}"${known.length ? ` — known: ${known.join(", ")}` : " — nothing is paired yet"}`,
        });
      }
      const cmd = buildCommand(body);
      if (cmd.error) return send(400, { error: cmd.error });
      if (!mqttConnected) return send(503, { error: OFFLINE });
      publishTo(targets, cmd);
      return send(200, { ok: true, applied: targets, command: cmd });
    }

    if (route === "POST /scene") {
      const name = normalize(body.name ?? body.scene);
      // The panic button: a stuck effect (strobe, colorloop the radio won't
      // let us cancel) dies to a power cycle. Hard OFF, a dark gap so the
      // mesh quiets down (directed stops were getting MAC_NO_ACK'd under
      // load), per-device effect stops, then known-good neutral white.
      if (name === "reset") {
        const targets = resolveTargets(cache, body.target);
        if (!targets) return send(404, { error: "nothing is paired yet" });
        if (!mqttConnected) return send(503, { error: OFFLINE });
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const allDevices = [...new Set(targets.topics.flatMap((t) => deviceTopicsFor(t)))];
        for (const t of targets.topics) client.publish(`${BASE}/${t}/set`, JSON.stringify({ state: "OFF", transition: 0 }));
        await sleep(4000);
        for (const d of allDevices) {
          client.publish(`${BASE}/${d}/set`, JSON.stringify({ effect: "stop_effect" }));
          await sleep(500);
          client.publish(`${BASE}/${d}/set`, JSON.stringify({ effect: "stop_colorloop" }));
          await sleep(500);
        }
        // Let the mesh drain before the ON — the first field run lost the
        // final group broadcast to congestion and left the room dark.
        await sleep(1500);
        const onCmd = { state: "ON", brightness: 178, color_temp: 250, transition: 1 };
        for (const t of targets.topics) client.publish(`${BASE}/${t}/set`, JSON.stringify(onCmd));
        // Verify against reported state; retry stragglers individually.
        await sleep(2500);
        const dark = allDevices.filter((d) => cache.states.get(d)?.state !== "ON");
        for (const d of dark) client.publish(`${BASE}/${d}/set`, JSON.stringify(onCmd));
        if (dark.length) await sleep(2000);
        const stillDark = allDevices.filter((d) => cache.states.get(d)?.state !== "ON");
        const errs = recentRadioErrors(20_000).filter((e) => e.message.includes("Publish 'set'"));
        return send(200, {
          ok: stillDark.length === 0,
          scene: "reset",
          applied: targets,
          verified: { on: allDevices.length - stillDark.length, of: allDevices.length },
          note:
            `power-cycled, effects cleared per device, restored to 70% neutral` +
            (dark.length ? `; ${dark.length} needed an individual retry` : "") +
            (stillDark.length ? ` — WARNING: ${stillDark.join(", ")} still not confirming ON (radio?) — may need a physical switch flip` : "") +
            (errs.length ? ` — ${errs.length} radio delivery failure(s) logged during the sequence` : ""),
        });
      }
      const spec = SCENES[name];
      if (!spec) return send(404, { error: `unknown scene "${body.name ?? body.scene ?? ""}" — have: ${[...Object.keys(SCENES), "reset"].join(", ")}` });
      const targets = resolveTargets(cache, body.target);
      if (!targets) return send(404, { error: "nothing is paired yet — no fixtures to apply the scene to" });
      if (!mqttConnected) return send(503, { error: OFFLINE });
      publishTo(targets, buildCommand(spec));
      return send(200, { ok: true, scene: name, applied: targets });
    }

    if (route === "POST /panel") {
      // The panel claims to BE the room — never render it from a possibly
      // drifted cache. ~2s of truth-read before first paint is the price.
      await refreshTruth();
      const r = await postPanel().catch(() => null);
      if (!r) return send(502, { error: "wall server unreachable" });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        return send(r.status, { error: err.error ?? `display refused (${r.status})` });
      }
      return send(200, { ok: true, view: "composite", title: PANEL_TITLE });
    }

    // Operator convenience for pairing sessions (also available in the Z2M
    // frontend). Deliberately NOT exposed through the lights MCP tool —
    // opening the mesh to joins is a human decision.
    if (route === "POST /permit_join") {
      if (!mqttConnected) return send(503, { error: OFFLINE });
      const time = Math.min(254, Math.max(0, Math.trunc(Number(body.time ?? 120))));
      client.publish(`${BASE}/bridge/request/permit_join`, JSON.stringify({ time }));
      return send(200, { ok: true, time });
    }

    return send(404, { error: "unknown route" });
  } catch (err) {
    return send(500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, "0.0.0.0", () => log(`http listening on :${PORT}`));
