#!/usr/bin/env node
// Dev orchestrator: runs server + web together, prints the Claude launch command.
import { spawn } from "node:child_process";

const procs = [
  { name: "server", cmd: "pnpm", args: ["--filter", "@tng/server", "dev"] },
  { name: "web", cmd: "pnpm", args: ["--filter", "@tng/web", "dev"] },
  // TTS sidecar is optional — speak degrades to captions if it fails to start
  { name: "tts", cmd: "uv", args: ["run", "--project", "apps/tts", "tng-tts"], optional: true },
];

for (const p of procs) {
  const child = spawn(p.cmd, p.args, { stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (err) => {
    if (!p.optional) throw err;
    console.error(`[dev] ${p.name} failed to start (${err.message}) — continuing without it`);
  });
  child.on("exit", (code) => {
    if (p.optional) {
      console.error(`[dev] ${p.name} exited (${code}) — continuing without it`);
      return;
    }
    console.error(`[dev] ${p.name} exited (${code}) — shutting down`);
    process.exit(code ?? 1);
  });
}

console.log(`
┌─────────────────────────────────────────────────────────────┐
│ TNG Computer dev                                            │
│   display:  http://127.0.0.1:5173   (pnpm kiosk for fullscreen)
│   TV kiosk: http://<windows-ip>:5173 from the LAN (make lan / docs/sops/tv-room-kiosk.md)
│   server:   http://127.0.0.1:3789/health
│
│ Launch the Computer (from ./claude):
│   cd claude && claude
│   (Phase 3 adds: --dangerously-load-development-channels server:bridge)
└─────────────────────────────────────────────────────────────┘
`);
