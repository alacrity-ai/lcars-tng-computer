#!/usr/bin/env node
/**
 * claudeops ops-agent (TNGC-54/55) — the remote-control sidecar for the
 * claude-ops session. A slim, ZERO-DEPENDENCY cousin of packages/bridge:
 * the session spawns it as an MCP stdio server (server name `opsbridge`),
 * it declares the experimental `claude/channel` capability, and commands
 * arriving over HTTP become channel events pushed into the session.
 *
 * Runs on the HOST (the claude-ops session has no docker sandbox). The TNG
 * bridge reaches it at host.docker.internal:7102 through a pinpoint fence
 * hole declared in plugins/claudeops/plugin.json.
 *
 * Truth model (all bridge-proven patterns):
 *  - busy/idle from the session's own hooks (UserPromptSubmit → /turn-start,
 *    Stop → /turn-end) — never guessed. Commands queue here while busy.
 *  - the RESULT of a turn is the transcript's last assistant text, read from
 *    the tail at /turn-end — that's what the tricorder shows as "what
 *    happened".
 *  - context % / model from transcript usage lines; effort from the config
 *    dir's settings.json.
 *  - /compact /model /effort are typed via `tmux send-keys` from validated
 *    values ONLY — the HTTP surface can never become a keystroke path.
 *
 * TNG_OPS gate: without TNG_OPS=1 in the environment (i.e. any interactive
 * claude session opened in the claude_ops repo, rather than `make
 * claude-ops`), the agent stays INERT: it speaks MCP so the CLI is happy,
 * but binds no port and pushes no channels — no cross-talk between a
 * developer session and the remote-controlled one.
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const ACTIVE = process.env.TNG_OPS === "1";
const PORT = Number(process.env.TNG_OPS_PORT ?? 7102);
const HOST = process.env.TNG_OPS_HOST ?? "127.0.0.1";
const TMUX_SESSION = process.env.TNG_OPS_TMUX ?? "claude-ops";
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const MAX_COMMAND_CHARS = 4000;
const RESULT_MAX_CHARS = 2400;
const COMPACT_ACK_MS = 12_000;
const COMPACT_FAILSAFE_MS = 10 * 60_000;
const BUSY_FAILSAFE_MS = 15 * 60_000;

// Mirrors @tng/contract (EFFORT_LEVELS / MODEL_VALUE_RE) — this file is
// zero-dep on purpose, so the values are copied, not imported.
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max", "ultracode", "auto"]);
const MODEL_VALUE_RE = /^[a-z0-9][a-z0-9.[\]-]{1,63}$/;

const log = (m) => console.error(`[opsbridge] ${m}`);

// ---- MCP stdio (hand-rolled: initialize / tools / channel notifications) ------

const INSTRUCTIONS =
  "Remote operations commands from Leif's tricorder arrive as channel events: " +
  '<channel source="opsbridge" user="..." device="...">command</channel>. ' +
  "Work each one exactly like a typed request from Leif. Your final text " +
  "message of the turn is relayed back to the tricorder as the result — end " +
  "every remotely-commanded turn with a concise, self-contained summary of " +
  "what was done (lead with the outcome; a phone screen is small).";

function mcpSend(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notification (initialized etc.) — nothing to do
  if (msg.method === "initialize") {
    mcpSend({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { experimental: { "claude/channel": {} }, tools: {} },
        serverInfo: { name: "opsbridge", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      },
    });
    return;
  }
  if (msg.method === "tools/list") {
    mcpSend({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
    return;
  }
  if (msg.method === "ping") {
    mcpSend({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  mcpSend({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
});

// The session died → the pipe closes → exit, releasing the port. Same
// orphan-proofing as the TNG bridge.
const shutdown = () => {
  log("stdin closed — shutting down");
  process.exit(0);
};
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);

// ---- dispatcher ----------------------------------------------------------------

let busy = false;
let busySince = 0;
let paused = false; // compaction holds everything
let accepted = 0;
let delivered = 0;
const queue = []; // {text, user, device, ts}
let lastCommand = null; // {text, user, ts, status: "queued"|"delivered"}
let lastResult = null; // {text, ts, forCommand: ts|null}

function dispatch() {
  if (paused || busy || queue.length === 0) return;
  const cmd = queue.shift();
  busy = true;
  busySince = Date.now();
  lastCommand = { text: cmd.text.slice(0, 200), user: cmd.user, ts: cmd.ts, status: "delivered" };
  try {
    mcpSend({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: {
        content: cmd.text,
        meta: { user: cmd.user, device: cmd.device, ts: String(cmd.ts) },
      },
    });
    delivered++;
    log(`delivered command from ${cmd.user}: "${cmd.text.slice(0, 60)}"`);
  } catch (err) {
    log(`channel push failed: ${err.message}`);
    busy = false;
  }
}

function onTurnStart() {
  busy = true;
  busySince = Date.now();
}

function onTurnEnd() {
  busy = false;
  // The Stop hook can fire before the final assistant line is flushed to
  // the transcript (observed live) — capture now, then re-capture shortly,
  // but never once a NEW turn has started (that would smear the next
  // turn's partial output over this one's result).
  captureResult();
  for (const delay of [1_200, 3_000]) {
    setTimeout(() => {
      if (!busy && !compacting) captureResult();
    }, delay).unref();
  }
  if (compactPending) {
    injectCompact();
    return;
  }
  if (flushPendingPrefs()) {
    setTimeout(dispatch, 600).unref();
    return;
  }
  dispatch();
}

// Lost-hook failsafe: degrade to dispatching, never wedge.
setInterval(() => {
  if (busy && Date.now() - busySince > BUSY_FAILSAFE_MS) {
    log("no turn-end for 15min — assuming the hook was lost, dispatching");
    onTurnEnd();
  }
}, 30_000).unref();

// ---- transcript truth: result summary + context meter --------------------------

let sessionTranscript = null;
let lastModel = null;
let lastContext = null; // {tokens, window, percent}

function setTranscript(p) {
  if (typeof p !== "string" || !p.trim() || p === sessionTranscript) return;
  sessionTranscript = p;
  lastContext = null;
  pollContext();
}

function readTail(path, bytes) {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function contextWindowFor(model) {
  if (/haiku/.test(model)) return 200_000;
  if (/\[1m\]/.test(model)) return 1_000_000;
  if (/opus-4|sonnet-4/.test(model)) return 200_000;
  return 1_000_000;
}

/** Scan the tail once for BOTH the newest usage line (context) and the
    newest assistant text (result). Sidechain lines are subagents — skip. */
function scanTranscript() {
  if (!sessionTranscript) return { usage: null, text: null };
  let text;
  try {
    text = readTail(sessionTranscript, 512 * 1024);
  } catch {
    return { usage: null, text: null };
  }
  const lines = text.split("\n");
  let usage = null;
  let resultText = null;
  for (let i = lines.length - 1; i >= 0 && (!usage || !resultText); i--) {
    const line = lines[i];
    if (!line.includes('"assistant"') && !line.includes('"usage"')) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // truncated first line of the tail window
    }
    if (ev.isSidechain === true) continue;
    const m = ev.message;
    if (!m) continue;
    if (!usage && m.usage && typeof m.usage.input_tokens === "number") {
      usage = m.usage;
      if (typeof m.model === "string") lastModel = m.model;
    }
    if (!resultText && ev.type === "assistant" && Array.isArray(m.content)) {
      const t = m.content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (t) resultText = t;
    }
  }
  return { usage, text: resultText };
}

function pollContext() {
  const { usage } = scanTranscript();
  if (!usage) return;
  const tokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.output_tokens ?? 0);
  const window = contextWindowFor(lastModel ?? "");
  lastContext = { tokens, window, percent: Math.min(100, Math.round((tokens / window) * 100)) };
}

function captureResult() {
  const { usage, text } = scanTranscript();
  if (usage) pollContext();
  if (!text) return;
  lastResult = {
    text: text.length > RESULT_MAX_CHARS ? text.slice(0, RESULT_MAX_CHARS - 1) + "…" : text,
    ts: Date.now(),
    forCommand: lastCommand?.status === "delivered" ? lastCommand.ts : null,
  };
}

let lastEffort = null;
function pollPrefs() {
  try {
    const s = JSON.parse(readFileSync(join(CONFIG_DIR, "settings.json"), "utf8"));
    if (typeof s.effortLevel === "string") lastEffort = s.effortLevel;
  } catch {
    // settings absent/mid-write — next poll
  }
}
setInterval(() => {
  pollContext();
  pollPrefs();
}, 15_000).unref();
setTimeout(pollPrefs, 1_000).unref();

// ---- tmux injection rails (/compact, /model, /effort) --------------------------

let compacting = false;
let compactingSince = 0;
let compactPending = false;
let compactAckTimer = null;
const pendingPrefs = new Map();

function tmuxSend(line, cb) {
  execFile("tmux", ["send-keys", "-t", TMUX_SESSION, line, "Enter"], cb);
}

function requestCompaction() {
  if (compacting) return { ok: false, state: "already-compacting" };
  if (compactPending || compactAckTimer) return { ok: false, state: "already-requested" };
  paused = true;
  if (busy) {
    compactPending = true;
    return { ok: true, state: "waiting-turn-end" };
  }
  injectCompact();
  return { ok: true, state: "injected" };
}

function injectCompact() {
  compactPending = false;
  log("injecting /compact via tmux");
  tmuxSend("/compact", (err) => {
    if (err) {
      compactFailed(`tmux send-keys failed: ${err.message}`);
      return;
    }
    compactAckTimer = setTimeout(() => compactFailed("no PreCompact ack"), COMPACT_ACK_MS);
  });
}

function compactFailed(reason) {
  log(`compaction request failed: ${reason}`);
  if (compactAckTimer) {
    clearTimeout(compactAckTimer);
    compactAckTimer = null;
  }
  compactPending = false;
  paused = false;
  dispatch();
}

function onCompactionStart() {
  if (compactAckTimer) {
    clearTimeout(compactAckTimer);
    compactAckTimer = null;
  }
  compactPending = false;
  if (compacting) return;
  paused = true;
  compacting = true;
  compactingSince = Date.now();
  log("compaction started — holding dispatch");
  startCompactWatch();
}

function onCompactionEnd() {
  stopCompactWatch();
  if (!compacting && !paused) return;
  compacting = false;
  paused = false;
  log("compaction complete — resuming");
  if (flushPendingPrefs()) setTimeout(dispatch, 600).unref();
  else dispatch();
  setTimeout(pollContext, 3_000).unref();
}

// PreCompact can fire and the compact still abort ("Not enough messages…") —
// no SessionStart(compact) ever comes. Watch the pane for a FRESH failure
// line (baseline-diffed), same as the TNG bridge (TNGC-32).
const COMPACT_FAIL_PATTERNS = [
  /not enough messages to compact/gi,
  /compaction (failed|canceled|cancelled)/gi,
  /error (compacting|during compaction)/gi,
];
let compactWatch = null;
let compactBaseline = null;

function countPatterns(text) {
  return COMPACT_FAIL_PATTERNS.map((re) => text.match(re)?.length ?? 0);
}
function capturePane(cb) {
  execFile("tmux", ["capture-pane", "-p", "-t", TMUX_SESSION], { maxBuffer: 1024 * 1024 }, (err, stdout) => {
    cb(err ? null : stdout);
  });
}
function startCompactWatch() {
  stopCompactWatch();
  capturePane((text) => {
    compactBaseline = text === null ? null : countPatterns(text);
  });
  compactWatch = setInterval(() => {
    if (!compacting) return;
    capturePane((text) => {
      if (text === null || !compacting) return;
      const now = countPatterns(text);
      const base = compactBaseline ?? now.map(() => 0);
      if (now.some((n, i) => n > (base[i] ?? 0))) {
        log("the session declined to compact — resuming");
        onCompactionEnd();
      }
    });
  }, 3_000);
  compactWatch.unref();
}
function stopCompactWatch() {
  if (compactWatch) {
    clearInterval(compactWatch);
    compactWatch = null;
  }
  compactBaseline = null;
}
setInterval(() => {
  if (compacting && Date.now() - compactingSince > COMPACT_FAILSAFE_MS) {
    log("no compaction-end for 10min — assuming the hook was lost, resuming");
    onCompactionEnd();
  }
}, 30_000).unref();

function requestSetPref(kind, value) {
  const valid =
    typeof value === "string" &&
    ((kind === "effort" && EFFORT_LEVELS.has(value)) || (kind === "model" && MODEL_VALUE_RE.test(value)));
  if (!valid) return { ok: false, state: "invalid value" };
  if (busy || compacting || paused) {
    pendingPrefs.set(kind, value);
    return { ok: true, state: "queued" };
  }
  injectPref(kind, value);
  return { ok: true, state: "injected" };
}

function injectPref(kind, value) {
  const line = kind === "effort" ? `/effort ${value}` : `/model ${value}`;
  log(`injecting ${line} via tmux`);
  tmuxSend(line, (err) => {
    if (err) {
      log(`${kind} injection failed: ${err.message} — is the session in tmux?`);
      return;
    }
    setTimeout(() => {
      pollPrefs();
      pollContext();
    }, 2_500).unref();
  });
}

function flushPendingPrefs() {
  if (pendingPrefs.size === 0 || busy || compacting || paused) return false;
  for (const [kind, value] of pendingPrefs) injectPref(kind, value);
  pendingPrefs.clear();
  return true;
}

// ---- state + HTTP surface ------------------------------------------------------

function state() {
  return {
    ok: true,
    status: compacting ? "compacting" : busy ? "working" : "idle",
    queued: queue.length,
    lastCommand,
    lastResult,
    model: lastModel,
    effort: lastEffort,
    context: lastContext,
    counters: { accepted, delivered },
    tmux: TMUX_SESSION,
    updatedAt: Date.now(),
  };
}

if (ACTIVE) {
  const http = createServer((req, res) => {
    const respond = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readBody = (fn) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          fn(raw ? JSON.parse(raw) : {});
        } catch {
          respond(400, { error: "invalid JSON body" });
        }
      });
    };

    if (req.method === "GET" && req.url === "/health") return respond(200, { ok: true, agent: "opsbridge" });
    if (req.method === "GET" && req.url === "/state") return respond(200, state());

    if (req.method === "POST" && req.url === "/command") {
      return readBody((body) => {
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text || text.length > MAX_COMMAND_CHARS) {
          return respond(400, { error: `text (1..${MAX_COMMAND_CHARS} chars) is required` });
        }
        accepted++;
        const cmd = {
          text,
          user: typeof body.user === "string" && body.user ? body.user : "leif",
          device: typeof body.device === "string" && body.device ? body.device : "tricorder",
          ts: Date.now(),
        };
        queue.push(cmd);
        if (busy || paused) lastCommand = { text: cmd.text.slice(0, 200), user: cmd.user, ts: cmd.ts, status: "queued" };
        dispatch();
        return respond(202, { ok: true, status: state().status, queued: queue.length });
      });
    }
    if (req.method === "POST" && req.url === "/compact") {
      const result = requestCompaction();
      return respond(result.ok ? 202 : 409, result);
    }
    if (req.method === "POST" && req.url === "/set-pref") {
      return readBody((body) => {
        const result = requestSetPref(typeof body.kind === "string" ? body.kind : "", body.value);
        respond(result.ok ? 202 : 400, result);
      });
    }

    // ---- session hooks (fail-open curls from .claude/settings.json) ----------
    if (req.method === "POST" && req.url === "/session-start") {
      return readBody((body) => {
        setTranscript(body.transcriptPath);
        respond(200, { ok: true });
      });
    }
    if (req.method === "POST" && req.url === "/turn-start") {
      return readBody((body) => {
        setTranscript(body.transcriptPath);
        onTurnStart();
        respond(200, { ok: true });
      });
    }
    if (req.method === "POST" && req.url === "/turn-end") {
      return readBody((body) => {
        // The Stop hook forwards transcript_path (unlike the TNG bridge's):
        // channel-delivered turns never fire UserPromptSubmit, and the
        // SessionStart post can race this agent's HTTP bind — re-binding at
        // every turn end is what makes result capture deterministic.
        setTranscript(body.transcriptPath);
        onTurnEnd();
        respond(200, { ok: true });
      });
    }
    if (req.method === "POST" && req.url === "/compaction-start") {
      return readBody((body) => {
        setTranscript(body.transcriptPath);
        onCompactionStart();
        respond(200, { ok: true });
      });
    }
    if (req.method === "POST" && req.url === "/compaction-end") {
      return readBody((body) => {
        setTranscript(body.transcriptPath);
        onCompactionEnd();
        respond(200, { ok: true });
      });
    }
    respond(404, { error: "not found" });
  });

  http.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      // Another remote-ops session already owns the port — this one degrades
      // to a plain session rather than fighting for it.
      log(`port ${PORT} already in use — another claude-ops agent is live; running inert`);
      return;
    }
    log(`http error: ${err.message}`);
  });
  http.listen(PORT, HOST, () => {
    log(`ops endpoint on http://${HOST}:${PORT} (tmux: ${TMUX_SESSION})`);
  });
} else {
  log("TNG_OPS not set — inert mode (MCP only, no remote control surface)");
}
