// The LIGHTING composite panel (TNGC-33 block language). Composed entirely
// from cached fabric state — building it never touches the mesh. The title
// "LIGHTING" doubles as the visibility marker: index.mjs only auto-refreshes
// while /api/console/screen shows a composite panel with this exact title.
import { miredsToKelvin } from "./control.mjs";

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
      for (const d of list) {
        const s = cache.states.get(d.friendly_name) ?? {};
        if (s.state === "ON") {
          on++;
          briSum += typeof s.brightness === "number" ? s.brightness : 254;
        }
      }
      items.push({ type: "status", label: "FIXTURES", state: on > 0 ? "on" : "off", detail: `${on}/${list.length} ON` });
      if (on > 0) {
        const avg = briSum / on / 254;
        items.push({ type: "gauge", label: "BRIGHTNESS", value: Math.min(1, avg), text: `${Math.round(avg * 100)}%`, accent: "gold" });
      }
    } else {
      for (const d of list) {
        const name = d.friendly_name;
        const s = cache.states.get(name) ?? {};
        const unavailable = cache.availability.get(name) === "offline";
        const on = s.state === "ON";
        const kelvin = typeof s.color_temp === "number" ? miredsToKelvin(s.color_temp) : null;
        items.push({
          type: "status",
          label: fixtureLabel(name, room),
          state: unavailable ? "idle" : on ? "on" : "off",
          detail: unavailable ? "UNREACHABLE" : on && kelvin ? `${kelvin}K` : undefined,
        });
        if (!unavailable && on) {
          const bri = typeof s.brightness === "number" ? s.brightness : 254;
          items.push({ type: "gauge", label: "BRIGHTNESS", value: Math.min(1, bri / 254), text: `${Math.round((bri / 254) * 100)}%`, accent: "gold" });
        }
      }
    }
    blocks.push({ type: "group", title: roomTitle(room), accent: "gold", items });
  }

  const columns = rooms.size >= 4 ? 3 : rooms.size >= 2 ? 2 : 1;
  return { title: PANEL_TITLE, accent: "gold", columns, blocks };
}
