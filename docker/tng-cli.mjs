#!/usr/bin/env node
// `tng` — the appliance's tiny ops CLI (TNGC-30/31), baked into the
// tng-computer image at /usr/local/bin/tng.
//
//   tng pair <code>   trade a Tricorder pairing code for the service token
//   tng doctor        one-shot health readout a helper can diagnose from
//   tng status        short pair/link summary
//
// Runs inside the computer container: token lives in the tng-pair volume at
// /var/lib/tng/token; the entrypoint blocks on that file when unpaired.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const TOKEN_FILE = "/var/lib/tng/token";
const META_FILE = "/var/lib/tng/pair.json";
const LINK_URL = process.env.TNG_TRICORDER_URL ?? "wss://tricorder.lalalimited.com/link";
const SERVER_URL = process.env.TNG_SERVER_URL ?? "http://stack:3789";
const BRIDGE_URL = "http://127.0.0.1:3791";

const apiBase = LINK_URL.replace(/^ws/, "http").replace(/\/link$/, "");

function out(line) { console.log(line); }
function die(msg) { console.error(msg); process.exit(1); }

async function getJson(url, timeoutMs = 4000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

async function pair(code) {
  if (!code) die("usage: tng pair <CODE>   (mint one in the Tricorder admin console)");
  let res;
  try {
    res = await fetch(`${apiBase}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    die(`Could not reach ${apiBase} — is this box online? (${e.message})`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) die("That code is invalid or expired — mint a fresh one in the admin console and try again.");
    if (res.status === 429) die("Too many attempts from this network — wait a few minutes.");
    die(`Pairing failed (${res.status}): ${data.error ?? "unknown error"}`);
  }
  mkdirSync("/var/lib/tng", { recursive: true });
  writeFileSync(TOKEN_FILE, data.serviceToken, { mode: 0o600 });
  writeFileSync(META_FILE, JSON.stringify({ tenant: data.tenant, linkUrl: data.linkUrl, pairedAt: Date.now() }, null, 2));
  out(`Paired with household "${data.tenant?.name ?? data.tenant?.slug}".`);
  out("If the Computer was waiting at NOT PAIRED it will start on its own within seconds.");
  out("If it was already running with an old pairing, restart it: docker compose restart computer");
}

function pairState() {
  if (process.env.TNG_TRICORDER_TOKEN) return { paired: true, source: "environment" };
  if (existsSync(TOKEN_FILE)) {
    let tenant = null;
    try { tenant = JSON.parse(readFileSync(META_FILE, "utf8")).tenant; } catch {}
    return { paired: true, source: "pairing volume", tenant };
  }
  return { paired: false };
}

async function status() {
  const p = pairState();
  out(p.paired
    ? `paired: yes (${p.source})${p.tenant ? ` — household "${p.tenant.slug}"` : ""}`
    : "paired: NO — run: tng pair <code>");
  try {
    const b = await getJson(`${BRIDGE_URL}/health`);
    out(`bridge: up — cloud link ${b.cloud} — delivered ${b.delivered}, queued ${b.queued}`);
  } catch {
    out("bridge: not running (is the Claude session up?)");
  }
}

async function doctor() {
  let bad = 0;
  const check = (name, ok, detail, hint) => {
    out(`${ok ? " ok " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) { bad++; if (hint) out(`       fix: ${hint}`); }
  };

  out(`tng doctor — mode: ${process.env.TNG_MODE ?? "dev"}`);

  // 1. pairing
  const p = pairState();
  check("pairing token", p.paired, p.paired ? `from ${p.source}` : "no token",
    "register at " + apiBase + " → admin console → Pair your Computer → tng pair <code>");

  // 2. cloud reachable
  let cloudOk = false;
  try { cloudOk = (await getJson(`${apiBase}/health`)).ok === true; } catch {}
  check("tricorder cloud reachable", cloudOk, apiBase,
    "check this box's internet; if you changed TNG_EXTRA_ALLOWED_DOMAINS, make sure the tricorder host is still allowed");

  // 3. bridge + link + channels delivery
  let bridge = null;
  try { bridge = await getJson(`${BRIDGE_URL}/health`); } catch {}
  check("bridge (the Computer's ear)", !!bridge, bridge ? `mode ${bridge.mode}` : "not running",
    "the Claude session isn't up — docker compose up -d computer, then docker compose logs computer");
  if (bridge) {
    check("cloud link", bridge.cloud === "up", `cloud: ${bridge.cloud}`,
      "token may have been rotated by a re-pair on another box — pair this box again (tng pair <code>)");
    // The silent-drop failure mode: a Claude Code update that loses the
    // research-preview channels flag accepts commands but never delivers them.
    const silentDrop = bridge.delivered === 0 && (bridge.accepted ?? 0) > 0;
    check("channel delivery", !silentDrop,
      `delivered ${bridge.delivered}, failures ${bridge.deliveryFailures}`,
      "commands reach the box but never reach Claude — the CLI likely dropped --dangerously-load-development-channels; use the pinned image version");
  }

  // 4. stack (wall + speech). TTS is checked THROUGH the server — the egress
  // fence only opens the server port, and the server proxies TTS health.
  let server = null;
  try { server = await getJson(`${SERVER_URL}/health`); } catch {}
  check("wall server", !!server,
    server ? `mode ${server.mode ?? "?"}, ${server.connectedDisplays ?? 0} display(s) connected` : SERVER_URL,
    "docker compose up -d stack, then docker compose logs stack");
  if (server && (server.connectedDisplays ?? 0) === 0) {
    out("       note: no display connected — open http://<box-ip>:5173 on the TV and tap ENGAGE");
  }
  try {
    const t = await getJson(`${SERVER_URL}/api/console/tts`);
    check("speech (TTS)", t.engine !== "offline", `${t.engine}${t.voice ? "/" + t.voice : ""}`,
      "voice falls back to on-screen captions; docker compose logs stack for the tts lines");
  } catch {
    check("speech (TTS)", false, "no answer via wall server", "voice falls back to on-screen captions; docker compose logs stack for the tts lines");
  }

  out(bad === 0 ? "\nAll systems nominal." : `\n${bad} problem${bad === 1 ? "" : "s"} found.`);
  process.exit(bad === 0 ? 0 : 1);
}

const [, , cmd, ...args] = process.argv;
if (cmd === "pair") await pair(args[0]);
else if (cmd === "doctor") await doctor();
else if (cmd === "status") await status();
else die("usage: tng <pair CODE | doctor | status>");
