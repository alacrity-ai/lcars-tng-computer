#!/usr/bin/env node
/**
 * Console MCP server — the Computer's hands.
 * Thin stdio MCP wrapper over the @tng/server console REST API.
 * All intelligence stays in the Claude session; this just forwards.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_SERVER_PORT } from "@tng/shared";

const BASE = process.env.TNG_SERVER_URL ?? `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;

async function call(path: string, body?: unknown): Promise<string> {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`server ${res.status}: ${text}`);
  return text;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const server = new McpServer({ name: "tng-console", version: "0.1.0" });

server.registerTool(
  "display",
  {
    description:
      "Render a panel on the LCARS display. Views: status (idle board), text {title?, body}, " +
      "alert {level: yellow|red, title?, message?}, blank, now-playing, weather, calendar, web, chart. " +
      "Props are view-specific.",
    inputSchema: {
      view: z.enum([
        "boot",
        "status",
        "text",
        "alert",
        "blank",
        "now-playing",
        "weather",
        "calendar",
        "web",
        "chart",
      ]),
      props: z.record(z.unknown()).optional(),
    },
  },
  async ({ view, props }) => textResult(await call("/api/console/display", { view, props })),
);

server.registerTool(
  "speak",
  {
    description:
      "Speak text aloud through the display's speakers in the Computer's voice. " +
      "Returns when playback completes. Keep utterances short and in-character.",
    inputSchema: {
      text: z.string().min(1),
      waitForPlayback: z.boolean().optional(),
    },
  },
  async ({ text, waitForPlayback }) =>
    textResult(await call("/api/console/speak", { text, waitForPlayback })),
);

server.registerTool(
  "chime",
  {
    description: "Play an earcon: acknowledge | complete | error | red-alert.",
    inputSchema: {
      name: z.enum(["acknowledge", "complete", "error", "red-alert"]),
    },
  },
  async ({ name }) => textResult(await call("/api/console/chime", { name })),
);

server.registerTool(
  "screen_state",
  {
    description: "What is currently on the LCARS display (view, props, connected display count).",
    inputSchema: {},
  },
  async () => textResult(await call("/api/console/screen")),
);

await server.connect(new StdioServerTransport());
