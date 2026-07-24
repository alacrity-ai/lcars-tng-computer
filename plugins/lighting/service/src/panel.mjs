// The LIGHTING composite panel (TNGC-33 block language). Composed entirely
// from cached fabric state — building it never touches the mesh. The title
// "LIGHTING" doubles as the visibility marker: index.mjs only auto-refreshes
// while /api/console/screen shows a composite panel with this exact title.
import { SCENES } from "./control.mjs";
import { currentColor } from "./color.mjs";

export const PANEL_TITLE = "LIGHTING";

/** Room = the friendly-name segment before "/" (living-room/ceiling). */
function byRoom(devices) {
  const rooms = new Map();
  for (const d of devices) {
    const name = d.friendly_name ?? "";
    const slash = name.indexOf("/");
    const room = slash > 0 ? name.slice(0, slash) : "unassigned";
    if (!rooms.has(room)) rooms.set(room, []);
    rooms.get(room).push(d);
  }
  return rooms;
}

function roomTitle(room) {
  return room.toUpperCase().replace(/-/g, " ");
}

function fixtureLabel(friendlyName, room) {
  const bare = room !== "unassigned" && friendlyName.startsWith(`${room}/`)
    ? friendlyName.slice(room.length + 1)
    : friendlyName;
  return bare.toUpperCase().replace(/-/g, " ");
}

export function composePanel(cache, mqttConnected) {
  const devices = cache.devices;
  const blocks = [];

  const fabric = !mqttConnected
    ? { state: "alert", detail: "MQTT LINK DOWN" }
    : cache.bridge !== "online"
      ? { state: "warn", detail: "ZIGBEE2MQTT OFFLINE" }
      : {
          state: "on",
          detail: `CHANNEL ${cache.info?.network?.channel ?? "—"} · ${devices.length} FIXTURE${devices.length === 1 ? "" : "S"}`,
        };
  blocks.push({ type: "status", label: "ZIGBEE FABRIC", state: fabric.state, detail: fabric.detail });
  // Pairing is a knob worth seeing from the couch: an open mesh means
  // anything nearby can join. Warn while open, quiet chip while closed.
  if (cache.info?.permit_join) {
    blocks.push({ type: "status", label: "PAIRING", state: "warn", detail: "OPEN — MESH JOINABLE" });
  } else {
    blocks.push({ type: "status", label: "PAIRING", state: "idle", detail: "CLOSED" });
  }
  blocks.push({ type: "divider" });

  if (devices.length === 0) {
    blocks.push({
      type: "text",
      body: "No fixtures are paired to the fabric yet. Pairing runs through the Zigbee2MQTT console — see the lighting plugin README.",
      role: "caption",
    });
    return { title: PANEL_TITLE, accent: "gold", columns: 1, blocks };
  }

  const rooms = byRoom(devices);
  // Full per-fixture detail up to ~14 fixtures; past that, collapse each room
  // to one line so a 24-bulb house still fits the 64-block panel cap.
  const compact = devices.length > 14;

  for (const [room, list] of rooms) {
    const items = [];
    if (compact) {
      let on = 0;
      let briSum = 0;
      let firstOnColor = null;
      for (const d of list) {
        const s = cache.states.get(d.friendly_name) ?? {};
        if (s.state === "ON") {
          on++;
          briSum += typeof s.brightness === "number" ? s.brightness : 254;
          firstOnColor ??= currentColor(s);
        }
      }
      items.push({ type: "status", label: "FIXTURES", state: on > 0 ? "on" : "off", detail: `${on}/${list.length} ON` });
      if (on > 0) {
        const avg = briSum / on / 254;
        items.push({ type: "gauge", label: "BRIGHTNESS", value: Math.min(1, avg), text: `${Math.round(avg * 100)}%`, accent: "gold" });
        if (firstOnColor) items.push({ type: "swatch", label: "COLOR", color: firstOnColor.hex, detail: firstOnColor.label });
      }
    } else {
      for (const d of list) {
        const name = d.friendly_name;
        const s = cache.states.get(name) ?? {};
        const unavailable = cache.availability.get(name) === "offline";
        const on = s.state === "ON";
        const lqi = typeof s.linkquality === "number" ? `LQI ${s.linkquality}` : undefined;
        items.push({
          type: "status",
          label: fixtureLabel(name, room),
          state: unavailable ? "idle" : on ? "on" : "off",
          detail: unavailable ? "UNREACHABLE" : lqi,
        });
        if (!unavailable && on) {
          const bri = typeof s.brightness === "number" ? s.brightness : 254;
          items.push({ type: "gauge", label: "BRIGHTNESS", value: Math.min(1, bri / 254), text: `${Math.round((bri / 254) * 100)}%`, accent: "gold" });
          const color = currentColor(s);
          if (color) items.push({ type: "swatch", label: "COLOR", color: color.hex, detail: color.label });
        }
      }
    }
    blocks.push({ type: "group", title: roomTitle(room), accent: "gold", items });
  }

  blocks.push({
    type: "text",
    body: `SCENES — ${Object.keys(SCENES).map((s) => s.toUpperCase().replace(/-/g, " ")).join(" · ")}`,
    role: "caption",
  });

  const columns = rooms.size >= 4 ? 3 : rooms.size >= 2 ? 2 : 1;
  return { title: PANEL_TITLE, accent: "gold", columns, blocks };
}
