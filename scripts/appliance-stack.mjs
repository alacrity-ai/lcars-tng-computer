#!/usr/bin/env node
// Appliance orchestrator (TNGC-30): server + TTS only. The wall is a static
// vite build served BY the server (TNG_WALL_DIST) — no vite process, one
// LAN-facing port. Dev installs keep using scripts/dev.mjs.
import { spawn } from "node:child_process";

const procs = [
  { name: "server", cmd: "pnpm", args: ["--filter", "@tng/server", "start"] },
  // TTS is optional at runtime — speak degrades to captions if it dies
  { name: "tts", cmd: "uv", args: ["run", "--project", "apps/tts", "tng-tts"], optional: true },
];

for (const p of procs) {
  const child = spawn(p.cmd, p.args, { stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (err) => {
    if (!p.optional) throw err;
    console.error(`[appliance] ${p.name} failed to start (${err.message}) — continuing without it`);
  });
  child.on("exit", (code) => {
    if (p.optional) {
      console.error(`[appliance] ${p.name} exited (${code}) — continuing without it`);
      return;
    }
    console.error(`[appliance] ${p.name} exited (${code}) — shutting down`);
    process.exit(code ?? 1);
  });
}

console.log("[appliance] TNG stack up — wall+API :3789 (mapped to :5173 by compose), tts :3790");
