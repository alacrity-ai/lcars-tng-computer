#!/usr/bin/env node
// Dev orchestrator: runs server + web together, prints the Claude launch command.
import { spawn } from "node:child_process";

const procs = [
  { name: "server", args: ["--filter", "@tng/server", "dev"] },
  { name: "web", args: ["--filter", "@tng/web", "dev"] },
];

for (const p of procs) {
  const child = spawn("pnpm", p.args, { stdio: ["ignore", "inherit", "inherit"] });
  child.on("exit", (code) => {
    console.error(`[dev] ${p.name} exited (${code}) — shutting down`);
    process.exit(code ?? 1);
  });
}

console.log(`
┌─────────────────────────────────────────────────────────────┐
│ TNG Computer dev                                            │
│   display:  http://127.0.0.1:5173   (pnpm kiosk for fullscreen)
│   server:   http://127.0.0.1:3789/health
│
│ Launch the Computer (from ./claude):
│   cd claude && claude
│   (Phase 3 adds: --dangerously-load-development-channels server:bridge)
└─────────────────────────────────────────────────────────────┘
`);
