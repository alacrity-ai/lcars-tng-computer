#!/usr/bin/env node
// lights MCP server (TNGC-9) — the brain's control plane for the Zigbee
// lighting fabric. Hand-rolled stdio JSON-RPC on purpose: plugin MCP servers
// run inside the fenced computer container where only the repo checkout
// exists, so zero dependencies means zero install steps in dev AND appliance.
// Transport per the MCP spec's stdio framing: one JSON-RPC message per line,
// stdout carries protocol only (logs go to stderr).
import { createInterface } from "node:readline";

const LIGHTING_URL = process.env.TNG_LIGHTING_URL ?? "http://lighting:7101";
const OFFLINE = "Lighting control is offline.";

const TOOL = {
  name: "lights",
  description:
    "Control the household Zigbee lighting fabric. Actions: on/off/set change lights " +
    "(target + brightness/colorTemp/color/transition), scene applies a named preset " +
    "(evening, movie, all-off, red-alert), status reports every fixture instantly from " +
    "cache (never probes the mesh), panel puts the LIGHTING dashboard on the wall. " +
    "Targets: a room/zone (living-room), a fixture (living-room/ceiling), or all (default).",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["on", "off", "set", "scene", "status", "panel"],
        description: "What to do. on/off need only target; set changes level/color; scene needs scene (or target as the scene name).",
      },
      target: {
        type: "string",
        description: "Room, zone, or fixture name; 'all' when omitted. For action=scene this scopes the scene (default whole house).",
      },
      scene: {
        type: "string",
        description: "Scene name for action=scene: evening | movie | all-off | red-alert",
      },
      brightness: { type: "number", description: "Percent 0-100 (0 turns off)" },
      colorTemp: {
        type: ["number", "string"],
        description: "White color temperature: kelvin 2200-6500, or warm | neutral | cool. Also the way back to white from a color.",
      },
      color: { type: "string", description: "Color name (red, amber, blue, ...) or #rrggbb" },
      transition: { type: "number", description: "Fade duration in seconds (default 1.5)" },
    },
    required: ["action"],
  },
};

const text = (t) => ({ content: [{ type: "text", text: t }] });
const errText = (t) => ({ content: [{ type: "text", text: t }], isError: true });

async function api(method, path, body) {
  const res = await fetch(`${LIGHTING_URL}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(6000),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, ...json };
}

function formatStatus(s) {
  const lines = [];
  const ch = s.coordinator?.channel ? ` (channel ${s.coordinator.channel})` : "";
  lines.push(`Zigbee fabric ${s.bridge}${ch}.`);
  if (!s.devices?.length) {
    lines.push("No fixtures paired yet.");
  } else {
    for (const d of s.devices) {
      const state = !d.available
        ? "UNREACHABLE"
        : d.on
          ? `ON — ${d.brightnessPct ?? 100}%${d.color ? `, ${d.color.label}` : ""}`
          : "off";
      lines.push(`- ${d.name}: ${state}`);
    }
  }
  if (s.groups?.length) lines.push(`Zones: ${s.groups.map((g) => g.name).join(", ")}`);
  lines.push(`Scenes: ${(s.scenes ?? []).join(", ")}`);
  return lines.join("\n");
}

function describeCommand(cmd) {
  const parts = [];
  if (cmd.state) parts.push(cmd.state);
  if (cmd.brightness !== undefined) parts.push(`${Math.round((cmd.brightness / 254) * 100)}%`);
  if (cmd.color_temp !== undefined) parts.push(`${Math.round(1_000_000 / cmd.color_temp)}K`);
  if (cmd.color?.hex) parts.push(cmd.color.hex);
  if (cmd.transition !== undefined) parts.push(`${cmd.transition}s fade`);
  return parts.join(", ");
}

async function callLights(args = {}) {
  const { action } = args;
  try {
    if (action === "status") {
      const s = await api("GET", "/state");
      return text(formatStatus(s));
    }
    if (action === "panel") {
      const r = await api("POST", "/panel", {});
      return r.ok ? text("Lighting panel is on the wall.") : errText(r.error ?? "display refused");
    }
    if (action === "scene") {
      const r = await api("POST", "/scene", { name: args.scene ?? args.target, target: args.scene ? args.target : undefined });
      if (!r.ok) return errText(r.status === 503 ? OFFLINE : (r.error ?? "scene failed"));
      return text(`Scene "${r.scene}" applied to ${r.applied.label} (${r.applied.topics.length} zone${r.applied.topics.length === 1 ? "" : "s"}).`);
    }
    if (action === "on" || action === "off" || action === "set") {
      const body = {
        target: args.target,
        brightness: args.brightness,
        colorTemp: args.colorTemp,
        color: args.color,
        transition: args.transition,
      };
      if (action === "on") body.state = "on";
      if (action === "off") body.state = "off";
      const r = await api("POST", "/set", body);
      if (!r.ok) return errText(r.status === 503 ? OFFLINE : (r.error ?? "command failed"));
      return text(`Done — ${r.applied.label}: ${describeCommand(r.command)}.`);
    }
    return errText(`unknown action "${action}" — use on | off | set | scene | status | panel`);
  } catch {
    return errText(OFFLINE);
  }
}

// ------------------------------------------------------------ JSON-RPC loop
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // not ours to answer — no id to attach an error to
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification — nothing to do
  try {
    if (method === "initialize") {
      return out({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "lights", version: "0.1.0" },
        },
      });
    }
    if (method === "ping") return out({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return out({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
    if (method === "resources/list") return out({ jsonrpc: "2.0", id, result: { resources: [] } });
    if (method === "prompts/list") return out({ jsonrpc: "2.0", id, result: { prompts: [] } });
    if (method === "tools/call") {
      if (params?.name !== "lights") {
        return out({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
      }
      const result = await callLights(params?.arguments);
      return out({ jsonrpc: "2.0", id, result });
    }
    return out({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (err) {
    return out({ jsonrpc: "2.0", id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } });
  }
});
