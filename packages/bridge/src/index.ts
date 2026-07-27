#!/usr/bin/env node
/**
 * Bridge MCP server — channel delivery into the Computer session (TNGC-18)
 * + Tricorder cloud link (TNGC-14) + THE command queue (TNGC-22).
 *
 * Delivery model: the bridge declares the experimental `claude/channel`
 * capability and owns a dispatcher queue. While the session is idle, an
 * arriving command is pushed immediately as a channel notification; while a
 * turn is running (known from hooks — UserPromptSubmit posts /turn-start,
 * Stop posts /turn-end), commands are HELD HERE, visible and withdrawable,
 * and the next one dispatches on turn end. Holding the queue bridge-side —
 * instead of letting events pile up invisibly inside the harness — is what
 * makes "show me the queue", "withdraw that", and "cancel the running one"
 * possible at all. There is still no blocking tool and no re-arm discipline:
 * the v1 await-loop (TNGC-13) died at timeout boundaries, and every queue
 * transition here is hook- or message-driven.
 *
 * Cancellation: a channel event cannot interrupt a running turn (mid-turn
 * events deliver NEXT turn, by design), so cancel rides hooks instead: a
 * withdraw aimed at the ACTIVE command arms an abort flag; the session's
 * PreToolUse hook (claude/hooks/pretool-abort.sh) polls /abort-check and
 * denies every non-console tool with a CANCELLED notice until the turn ends.
 * An already-executing tool call runs out — the axe falls at the next one.
 *
 * Two producers feed the same queue:
 *  - local HTTP POST /message (office push-to-talk via scripts/say.sh)
 *  - an OUTBOUND WebSocket to the Tricorder Durable Object (phones anywhere).
 *    Outbound-only: nothing on the internet can reach into the house.
 *
 * Cloud contract (see @tng/contract): the hub persists every message and
 * replays unacked ones on reconnect; we ack at DISPATCH (or withdrawal), so
 * commands still queued here survive a bridge restart via replay + dedupe.
 * The TTL is an ARRIVAL check — once a command is visibly queued (and
 * withdrawable), waiting out a long turn is legitimate, not staleness.
 * Every queue change is published: count to the wall's badge, full snapshot
 * to the cloud (`queue` up-frame → the PWA's queue screen).
 *
 * Requires the session to be launched with:
 *   claude --dangerously-load-development-channels server:bridge
 * Without it, notifications are dropped SILENTLY (research-preview behavior)
 * — the peek_messages tool and /health exist to diagnose exactly that.
 */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import WebSocket from "ws";
import type {
  CloudControlCommand,
  ComputerInfo,
  LightsState,
  LinkDownFrame,
  LinkUpFrame,
  MediaState,
  PluginStatus,
  PluginTile,
  QueueItem,
  RosterDisplay,
  TngMessage,
} from "@tng/contract";
import { EFFORT_LEVELS, MODEL_VALUE_RE } from "@tng/contract";
import { cloudFetch, getItem } from "@tng/library-client";

const PORT = Number(process.env.TNG_BRIDGE_PORT ?? 3791);
/** Voice commands are ephemeral speech: anything older than this ON ARRIVAL
    (fresh post or cloud replay) is dropped, not executed. Deliberately-held
    queue time does NOT count — a visible queue makes waiting legitimate. */
const TTL_MS = Number(process.env.TNG_MESSAGE_TTL_MS ?? 60_000);
/** If a turn runs longer than this without a Stop, assume the hook was lost
    and fall back to immediate dispatch (harness-side queueing — the pre-22
    behavior). Degrades, never wedges. */
const BUSY_FAILSAFE_MS = Number(process.env.TNG_BUSY_FAILSAFE_MS ?? 10 * 60_000);
const CLOUD_URL = process.env.TNG_TRICORDER_URL;
const CLOUD_TOKEN = process.env.TNG_TRICORDER_TOKEN;
const SERVER_URL = process.env.TNG_SERVER_URL ?? "http://127.0.0.1:3789";

interface QueuedCommand extends TngMessage {
  /** Queue identity: the cloud id for phone commands, `loc_…` for local. */
  id: string;
  cloudId?: string;
  /** TNGC-23: a library display command — deterministic, no session turn.
      `transcript` carries the item title; the payload is fetched from the
      cloud only at dispatch time. */
  kind?: "transcript" | "display";
  itemId?: string;
}

// ---- MCP server (channel capability) ----------------------------------------

const server = new McpServer(
  { name: "tng-bridge", version: "0.8.0" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions:
      "Voice commands from household members arrive as channel events: " +
      '<channel source="bridge" user="..." device="..." wall="...">transcript</channel>. ' +
      "They are one-way spoken requests — service each exactly like a spoken command per " +
      "CLAUDE.md (instant spoken acknowledgment, display-before-speak), addressing the " +
      'user named on the event and resolving "my"/"me" against that user. `wall` is the ' +
      "viewscreen the command targets — the console server ALREADY routes output there by " +
      "default (the bridge reports it), so never pass a wall param to console tools unless " +
      "the person names a DIFFERENT room ('...on the living room wall'). The bridge " +
      "dispatches one command per turn; the rest wait in a visible queue. If a tool call " +
      "is denied with a CANCELLED notice, the person cancelled the current command from " +
      "their tricorder: abandon the task at once, speak one short acknowledgment " +
      "('Belayed.'), and end the turn.",
  },
);

// ---- queue state (TNGC-22) ----------------------------------------------------

let delivered = 0;
let deliveryFailures = 0;
// Commands ACCEPTED into the dispatcher (fresh, non-stale). `tng doctor`
// compares this with `delivered` to catch the silent-drop failure mode:
// accepted climbing while delivered stays 0 means commands reach this box
// but never reach the session (TNGC-31).
let accepted = 0;
/** deliveryFailures high-water mark at the last wall alert (one per streak). */
let deliveredAtLastAlert = 0;
const queue: QueuedCommand[] = [];
let active: QueuedCommand | null = null;
let abortRequest: { by: string; at: number } | null = null;
let busy = false;
let busySince = 0;

/** Ring buffer of recent messages for diagnostics (peek_messages / debugging
    silent channel drops). NOT the delivery path. */
const recent: Array<QueuedCommand & { deliveredAt: number; pushed: boolean }> = [];

function snapshot(): QueueItem[] {
  const pub = (c: QueuedCommand, isActive: boolean): QueueItem => ({
    id: c.id,
    user: c.user,
    device: c.device,
    transcript: c.transcript.length > 140 ? c.transcript.slice(0, 139) + "…" : c.transcript,
    ts: c.ts,
    ...(isActive ? { active: true } : {}),
    ...(isActive && abortRequest ? { cancelling: true } : {}),
    ...(c.kind === "display" ? { kind: "display" as const, itemId: c.itemId } : {}),
    ...(c.wall ? { wall: c.wall } : {}),
  });
  return [...(active ? [pub(active, true)] : []), ...queue.map((c) => pub(c, false))];
}

/** Tell the console server whose command is being served and which wall it
    targets — THE origin default every console route keys off (TNGC-35).
    Awaited at dispatch so the session's first tool call finds it set. */
async function postOrigin(wall: string | null, user: string | null): Promise<void> {
  try {
    await fetch(`${SERVER_URL}/api/console/origin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wall, user }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // routing degrades to the primary wall; never blocks dispatch
  }
}

/** Publish every queue change: count → wall badge, snapshot → cloud/PWA. */
function pushState(): void {
  const items = snapshot();
  void fetch(`${SERVER_URL}/api/console/command-pending`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ count: items.length }),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => {
    // wall badge is best-effort; the count re-syncs on the next change
  });
  if (cloudSocket?.readyState === WebSocket.OPEN) {
    const frame: LinkUpFrame = { v: 1, type: "queue", items };
    try {
      cloudSocket.send(JSON.stringify(frame));
    } catch {
      // link recycling — the open handler re-syncs
    }
  }
}

function ackCloud(cloudId: string | undefined): void {
  if (!cloudId || cloudSocket?.readyState !== WebSocket.OPEN) return;
  const frame: LinkUpFrame = { v: 1, type: "ack", id: cloudId };
  try {
    cloudSocket.send(JSON.stringify(frame));
  } catch {
    // hub replays, dedupe eats it
  }
}

function enqueue(msg: TngMessage & { cloudId?: string; kind?: "transcript" | "display"; itemId?: string }): void {
  const age = Date.now() - msg.ts;
  if (age > TTL_MS) {
    console.error(
      `[bridge] dropped stale message on arrival (${Math.round(age / 1000)}s old): "${msg.transcript.slice(0, 60)}"`,
    );
    ackCloud(msg.cloudId); // stale: never execute, never replay
    return;
  }
  accepted++;
  queue.push({ ...msg, id: msg.cloudId ?? `loc_${randomUUID()}` });
  dispatch();
  pushState();
}

/** A library display command (TNGC-23): fetch the payload from the cloud and
    POST it straight to the console server — deterministic, no channel event,
    no session turn, no LLM tokens. Payload bytes flow cloud → here → wall
    server; never near model context. Failures are logged and acked (the
    user retries from the phone; a failed display must never replay). */
async function executeDisplay(cmd: QueuedCommand): Promise<void> {
  try {
    const { item, props } = await getItem(cmd.itemId!);
    const res = await fetch(`${SERVER_URL}/api/console/display`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view: item.view, props, ...(cmd.wall ? { wall: cmd.wall } : {}) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`console server ${res.status}`);
    console.error(`[bridge] displayed library item "${cmd.transcript}" for ${cmd.user}`);
  } catch (err) {
    console.error(`[bridge] library display failed (${cmd.itemId}): ${(err as Error).message}`);
  } finally {
    ackCloud(cmd.cloudId);
    pushState();
  }
}

/** Push the next command into the session if it's idle. One TRANSCRIPT per
    turn; display commands at the head run immediately (they don't consume a
    turn or set busy) but still wait their turn behind a queued transcript —
    the queue is strictly ordered. */
function dispatch(): void {
  // Memory consolidation holds EVERYTHING (TNGC-32): the queue is strictly
  // ordered, and typing into the session mid-compact is undefined behavior.
  if (paused) return;
  while (!busy && queue.length > 0 && queue[0].kind === "display") {
    void executeDisplay(queue.shift()!);
  }
  if (busy || queue.length === 0) return;
  const cmd = queue.shift()!;
  busy = true;
  busySince = Date.now();
  active = cmd;
  void (async () => {
    let pushed = false;
    try {
      // Origin first (awaited): the session's first console call must find
      // the [user → wall] routing default already in place.
      await postOrigin(cmd.wall ?? null, cmd.user);
      await server.server.notification({
        method: "notifications/claude/channel",
        params: {
          content: cmd.transcript,
          // meta keys must be plain identifiers; values must be strings.
          meta: {
            user: cmd.user,
            device: cmd.device,
            ts: String(cmd.ts),
            ...(cmd.wall ? { wall: cmd.wall } : {}),
          },
        },
      });
      pushed = true;
      delivered++;
      ackCloud(cmd.cloudId);
    } catch (err) {
      deliveryFailures++;
      console.error(`[bridge] channel notification failed: ${(err as Error).message}`);
      // transport is broken, not busy — let the next event try again
      busy = false;
      active = null;
      // Never a silent hang (TNGC-31): after a streak of failures, say so ON
      // THE WALL — the classic cause is a Claude CLI that lost the
      // research-preview channels flag. One panel per streak.
      if (deliveryFailures - deliveredAtLastAlert >= 3) {
        deliveredAtLastAlert = deliveryFailures;
        void fetch(`${SERVER_URL}/api/console/display`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            view: "alert",
            props: {
              level: "yellow",
              title: "VOICE LINK FAULT",
              message: "Commands are reaching this Computer but cannot reach the session. Run: docker compose exec computer tng doctor",
            },
          }),
        }).catch(() => {});
      }
    }
    recent.push({ ...cmd, deliveredAt: Date.now(), pushed });
    while (recent.length > 20) recent.shift();
    pushState();
  })();
}

/** Withdraw a queued command, or arm cancellation of the active one. */
function withdraw(id: string, by: string): { ok: boolean; state?: string; error?: string } {
  const idx = queue.findIndex((c) => c.id === id);
  if (idx >= 0) {
    const [gone] = queue.splice(idx, 1);
    ackCloud(gone.cloudId); // never executed — but never replay it either
    console.error(`[bridge] "${gone.transcript.slice(0, 40)}" withdrawn by ${by}`);
    pushState();
    return { ok: true, state: "withdrawn" };
  }
  if (active?.id === id) {
    abortRequest = { by, at: Date.now() };
    console.error(`[bridge] active command cancel requested by ${by}`);
    pushState();
    return { ok: true, state: "cancelling" };
  }
  return { ok: false, error: "no such command (already finished?)" };
}

function onTurnStart(): void {
  // busy already true = the turn OUR dispatch just started (origin is set,
  // leave it). busy false = a typed developer prompt — no wall behind it,
  // so clear any stale origin before holding the queue.
  if (!busy) void postOrigin(null, null);
  busy = true;
  busySince = Date.now();
}

function onTurnEnd(): void {
  busy = false;
  active = null;
  abortRequest = null;
  void postOrigin(null, null); // the served command's routing default expires with its turn
  // A compaction request that arrived mid-turn injects the moment the turn
  // ends — before any queued command can start a new one (TNGC-32).
  if (compactPending) {
    injectCompact(compactPending.by);
    pushState();
    return;
  }
  // Queued /model / /effort changes land on the idle composer first; the
  // next command dispatches a beat later so the keystrokes can't interleave.
  if (flushPendingPrefs()) {
    setTimeout(() => {
      dispatch();
      pushState();
    }, 600).unref();
    return;
  }
  dispatch();
  pushState();
}

// ---- memory consolidation (TNGC-32) --------------------------------------------
// The session runs inside tmux (make computer / appliance CMD); /compact is a
// CLI-level command no tool or hook can invoke, so the bridge types it via
// `tmux send-keys` — from a hardcoded whitelist, never free text. Flow:
// admin presses Compact in the PWA → `compact` down-frame (or local POST
// /compact) → hold the dispatcher → wait for any running turn to Stop →
// inject → the session's PreCompact hook is the ACK (also fires for
// AUTO-compact, which gets the badge + hold for free) → SessionStart(compact)
// hook ends it. Every transition is visible: badge on every screen via the
// console server, state up the link for the PWA. Never a silent hang — a
// missing ACK unpauses and says so on the wall.

const TMUX_SESSION = process.env.TNG_TMUX_SESSION ?? "tng";
const COMPACT_ACK_MS = Number(process.env.TNG_COMPACT_ACK_MS ?? 12_000);
const COMPACT_FAILSAFE_MS = Number(process.env.TNG_COMPACT_FAILSAFE_MS ?? 10 * 60_000);

let paused = false;
let compacting = false;
let compactingSince = 0;
let compactPending: { by: string } | null = null;
let compactAckTimer: NodeJS.Timeout | null = null;

function postCompactionBadge(active: boolean): void {
  void fetch(`${SERVER_URL}/api/console/compaction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ active }),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => {
    // badge is best-effort; state still flows up the link
  });
}

function requestCompaction(by: string): { ok: boolean; state: string } {
  if (compacting) return { ok: false, state: "already-compacting" };
  if (compactPending || compactAckTimer) return { ok: false, state: "already-requested" };
  paused = true;
  if (busy) {
    compactPending = { by };
    console.error(`[bridge] compaction requested by ${by} — waiting for the running turn to end`);
    return { ok: true, state: "waiting-turn-end" };
  }
  injectCompact(by);
  return { ok: true, state: "injected" };
}

/** The ONLY text the bridge may ever type into the session. Voice/cloud must
    never become a general keystroke path into the terminal. */
const INJECT_WHITELIST = new Set(["/compact"]);

function injectCompact(by: string): void {
  compactPending = null;
  const cmd = "/compact";
  if (!INJECT_WHITELIST.has(cmd)) return;
  console.error(`[bridge] injecting ${cmd} via tmux (requested by ${by})`);
  execFile("tmux", ["send-keys", "-t", TMUX_SESSION, cmd, "Enter"], (err) => {
    if (err) {
      compactFailed(`tmux send-keys failed: ${err.message}`);
      return;
    }
    // send-keys is best-effort typing into a UI — PreCompact is the real ACK.
    compactAckTimer = setTimeout(() => compactFailed("the session did not start compacting (no PreCompact ack)"), COMPACT_ACK_MS);
  });
}

function compactFailed(reason: string): void {
  console.error(`[bridge] compaction request failed: ${reason}`);
  if (compactAckTimer) {
    clearTimeout(compactAckTimer);
    compactAckTimer = null;
  }
  compactPending = null;
  paused = false;
  dispatch();
  pushState();
  sendComputerInfo(true);
  void fetch(`${SERVER_URL}/api/console/display`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      view: "alert",
      props: {
        level: "yellow",
        title: "MEMORY CONSOLIDATION FAILED",
        message: `${reason}. Commands resume normally. Is the session running inside tmux (rebuild: make computer-image)?`,
      },
    }),
    signal: AbortSignal.timeout(3_000),
  }).catch(() => {});
}

/** PreCompact hook — fires for the injected /compact AND for auto-compact. */
function onCompactionStart(trigger: string): void {
  if (compactAckTimer) {
    clearTimeout(compactAckTimer);
    compactAckTimer = null;
  }
  compactPending = null;
  if (compacting) return;
  paused = true;
  compacting = true;
  compactingSince = Date.now();
  console.error(`[bridge] memory consolidation started (${trigger}) — dispatcher holding`);
  postCompactionBadge(true);
  sendComputerInfo(true);
  pushState();
  startCompactWatch();
}

/** SessionStart(compact) hook — consolidation finished, session is back. */
function onCompactionEnd(): void {
  stopCompactWatch();
  if (!compacting && !paused) return;
  compacting = false;
  paused = false;
  console.error("[bridge] memory consolidation complete — dispatcher resuming");
  postCompactionBadge(false);
  sendComputerInfo(true);
  if (flushPendingPrefs()) {
    setTimeout(() => {
      dispatch();
      pushState();
    }, 600).unref();
  } else {
    dispatch();
    pushState();
  }
  // the transcript rolled — re-read from the new file promptly
  setTimeout(pollContext, 3_000).unref();
}

// PreCompact can fire and the compact still abort ("Not enough messages to
// compact") — which never emits SessionStart(compact), so the badge would
// hang until the failsafe. The bridge owns the pane anyway: while compacting,
// watch it for a FRESH failure line (baseline-diffed so an old message still
// on screen can't false-trigger) and treat that as the end.
const COMPACT_WATCH_MS = Number(process.env.TNG_COMPACT_WATCH_MS ?? 3_000);
const COMPACT_FAIL_PATTERNS = [
  /not enough messages to compact/gi,
  /compaction (failed|canceled|cancelled)/gi,
  /error (compacting|during compaction)/gi,
];

let compactWatch: NodeJS.Timeout | null = null;
let compactBaseline: number[] | null = null;

function countPatterns(text: string): number[] {
  return COMPACT_FAIL_PATTERNS.map((re) => text.match(re)?.length ?? 0);
}

function capturePane(cb: (text: string | null) => void): void {
  execFile("tmux", ["capture-pane", "-p", "-t", TMUX_SESSION], { maxBuffer: 1024 * 1024 }, (err, stdout) => {
    cb(err ? null : stdout);
  });
}

function startCompactWatch(): void {
  stopCompactWatch();
  compactBaseline = null;
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
        console.error("[bridge] the session reported the compact aborted — resuming");
        onCompactionEnd();
        void fetch(`${SERVER_URL}/api/console/display`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            view: "alert",
            props: {
              level: "yellow",
              title: "MEMORY CONSOLIDATION STOPPED",
              message: "The session declined to compact (usually: not enough to consolidate yet). Commands resume normally.",
            },
          }),
          signal: AbortSignal.timeout(3_000),
        }).catch(() => {});
      }
    });
  }, COMPACT_WATCH_MS);
  compactWatch.unref();
}

function stopCompactWatch(): void {
  if (compactWatch) {
    clearInterval(compactWatch);
    compactWatch = null;
  }
  compactBaseline = null;
}

// ---- session preferences: /model + /effort (TNGC-32 follow-up) -----------------
// Same rails as /compact: the injected line is BUILT from a validated value
// (enum for effort, one shell-safe token for model) — never relayed text.
// Mid-turn/mid-compaction requests wait and flush at the next safe moment.
// No hook acks these; truth flows back on its own (effort re-reads
// settings.json, model shows on the next assistant message's transcript line).

const pendingPrefs = new Map<"model" | "effort", string>();

function validPref(kind: string, value: string): kind is "model" | "effort" {
  if (kind === "effort") return (EFFORT_LEVELS as readonly string[]).includes(value);
  if (kind === "model") return MODEL_VALUE_RE.test(value);
  return false;
}

function requestSetPref(kind: string, value: unknown, by: string): { ok: boolean; state: string } {
  if (typeof value !== "string" || !validPref(kind, value)) {
    return { ok: false, state: "invalid value" };
  }
  if (busy || compacting || paused) {
    pendingPrefs.set(kind, value);
    console.error(`[bridge] ${kind}=${value} queued by ${by} — session busy, applying at next idle`);
    pushState();
    return { ok: true, state: "queued" };
  }
  injectPref(kind, value, by);
  return { ok: true, state: "injected" };
}

function injectPref(kind: "model" | "effort", value: string, by: string): void {
  const line = kind === "effort" ? `/effort ${value}` : `/model ${value}`;
  console.error(`[bridge] injecting ${line} via tmux (requested by ${by})`);
  execFile("tmux", ["send-keys", "-t", TMUX_SESSION, line, "Enter"], (err) => {
    if (err) {
      console.error(`[bridge] ${kind} injection failed: ${err.message} — is the session in tmux?`);
      return;
    }
    // no hook fires for these — refresh the truth sources shortly after
    setTimeout(() => {
      pollPrefs();
      pollContext();
      sendComputerInfo(true);
    }, 2_500).unref();
  });
}

/** Applied at turn end / compaction end — one settle beat before dispatch so
    the typed slash commands land on an idle composer. */
function flushPendingPrefs(): boolean {
  if (pendingPrefs.size === 0 || busy || compacting || paused) return false;
  for (const [kind, value] of pendingPrefs) injectPref(kind, value, "queued");
  pendingPrefs.clear();
  return true;
}

// A lost SessionStart hook must degrade, not wedge the house (TNGC-32).
setInterval(() => {
  if (compacting && Date.now() - compactingSince > COMPACT_FAILSAFE_MS) {
    console.error(
      `[bridge] no compaction-end for ${Math.round(COMPACT_FAILSAFE_MS / 60000)}min — assuming the hook was lost, resuming`,
    );
    onCompactionEnd();
  }
}, 30_000).unref();

// ---- context meter (TNGC-32) ----------------------------------------------------
// The session transcript records exact `usage` on every assistant message;
// the newest jsonl under $CLAUDE_CONFIG_DIR/projects is the live session
// (newest-FILE logic matters — compaction rolls files). Stateless re-scan
// every 15s; ~256KB tail read, cheap.

const WINDOW_OVERRIDE = Number(process.env.TNG_CONTEXT_WINDOW ?? 0);
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

/** The persisted effort level — /effort writes it to settings.json, so this
    file IS the truth (verified live 2026-07-24: {"effortLevel":"high"}). */
let lastEffort: string | undefined;

function pollPrefs(): void {
  try {
    const s = JSON.parse(readFileSync(join(CONFIG_DIR, "settings.json"), "utf8")) as { effortLevel?: unknown };
    if (typeof s.effortLevel === "string" && s.effortLevel !== lastEffort) {
      lastEffort = s.effortLevel;
      sendComputerInfo(false);
    }
  } catch {
    // settings file absent/mid-write — next poll catches up
  }
}

/** Per Anthropic's model table (checked 2026-07-24): the whole Claude 5
    family — Fable 5, Opus 5, Sonnet 5 — is 1M context; Haiku 4.5 is 200k.
    Legacy 4.x tiers were 200k unless the id carries the [1m] variant tag.
    TNG_CONTEXT_WINDOW overrides everything. */
function contextWindowFor(model: string): number {
  if (WINDOW_OVERRIDE > 0) return WINDOW_OVERRIDE;
  if (/haiku/.test(model)) return 200_000;
  if (/\[1m\]/.test(model)) return 1_000_000;
  if (/opus-4|sonnet-4/.test(model)) return 200_000;
  return 1_000_000;
}

let lastContext: { tokens: number; window: number; percent: number } | null = null;
let lastModel: string | undefined;

/** THE live transcript, as reported by hooks (every hook receives
    transcript_path on stdin; the turn-start/compaction hooks forward it).
    Never guessed: a newest-file heuristic reads the PREVIOUS session's file
    on a fresh launch (and can catch subagent transcripts) — the 73%-on-a-
    fresh-session bug. Unknown → the meter reports nothing. */
let sessionTranscript: string | null = null;

function setTranscript(p: unknown): void {
  if (typeof p !== "string" || !p.trim() || p === sessionTranscript) return;
  sessionTranscript = p;
  lastContext = null; // never show the old file's number against a new file
  pollContext();
}

function readTail(path: string, bytes: number): string {
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

function pollContext(): void {
  if (!sessionTranscript) return;
  let text: string;
  try {
    text = readTail(sessionTranscript, 256 * 1024);
  } catch {
    return; // rolled away (post-compact) — the SessionStart hook re-points us
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"usage"')) continue;
    try {
      const ev = JSON.parse(line) as {
        isSidechain?: boolean;
        message?: { model?: string; usage?: Record<string, number> };
      };
      // Subagent turns record their OWN context, not the session's.
      if (ev.isSidechain === true) continue;
      const u = ev.message?.usage;
      if (!u || typeof u.input_tokens !== "number") continue;
      const tokens =
        (u.input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.output_tokens ?? 0);
      if (typeof ev.message?.model === "string") lastModel = ev.message.model;
      const window = contextWindowFor(lastModel ?? "");
      lastContext = { tokens, window, percent: Math.min(100, Math.round((tokens / window) * 100)) };
      sendComputerInfo(false);
      return;
    } catch {
      // truncated first line of the tail window — keep scanning upward
    }
  }
}
setInterval(() => {
  pollContext();
  pollPrefs();
}, 15_000).unref();
// First read AFTER module init completes — these touch cloudSocket, whose
// `let` lives further down this file (TDZ at load time otherwise).
setTimeout(() => {
  pollContext();
  pollPrefs();
}, 1_000).unref();

let lastComputerKey = "";

function computerInfo(): ComputerInfo {
  return {
    ...(lastContext ? { context: lastContext } : {}),
    ...(lastModel ? { model: lastModel } : {}),
    ...(lastEffort ? { effort: lastEffort } : {}),
    compacting,
    updatedAt: Date.now(),
  };
}

/** Push context/compaction state up the link — on change, or forced at
    transitions and link-open (the PWA admin console reads it from the hub). */
function sendComputerInfo(force: boolean): void {
  const info = computerInfo();
  const key = `${info.context?.percent ?? -1}|${info.compacting}|${info.model ?? ""}|${info.effort ?? ""}`;
  if (!force && key === lastComputerKey) return;
  lastComputerKey = key;
  if (cloudSocket?.readyState === WebSocket.OPEN) {
    const frame: LinkUpFrame = { v: 1, type: "computer", info };
    try {
      cloudSocket.send(JSON.stringify(frame));
    } catch {
      // link recycling — the open handler re-syncs
    }
  }
}

// Failsafe: a lost Stop hook must degrade to pre-queue behavior, not wedge.
setInterval(() => {
  if (busy && Date.now() - busySince > BUSY_FAILSAFE_MS) {
    console.error(
      `[bridge] no turn-end for ${Math.round(BUSY_FAILSAFE_MS / 60000)}min — assuming the hook was lost, dispatching`,
    );
    onTurnEnd();
  }
}, 30_000).unref();

// Replay dedupe: ids already enqueued once (ack may have been lost).
const seenCloudIds = new Set<string>();
const seenOrder: string[] = [];
function firstSighting(id: string): boolean {
  if (seenCloudIds.has(id)) return false;
  seenCloudIds.add(id);
  seenOrder.push(id);
  while (seenOrder.length > 500) seenCloudIds.delete(seenOrder.shift()!);
  return true;
}

// ---- local endpoints (producer + hooks + queue control) -----------------------

const http = createServer((req, res) => {
  const respond = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (fn: (body: Record<string, unknown>) => void) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        fn(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        respond(400, { error: "invalid JSON body" });
      }
    });
  };

  if (req.method === "GET" && req.url === "/health") {
    return respond(200, {
      ok: true,
      mode: "channel-push",
      accepted,
      delivered,
      deliveryFailures,
      busy,
      active: active ? { id: active.id, user: active.user, cancelling: !!abortRequest } : null,
      queued: queue.length,
      ttlMs: TTL_MS,
      cloud: cloudState,
      // TNGC-32: context meter + consolidation state (tng doctor reads this)
      paused,
      compacting,
      context: lastContext,
      model: lastModel ?? null,
      effort: lastEffort ?? null,
      pendingPrefs: Object.fromEntries(pendingPrefs),
      transcript: sessionTranscript,
      // TNGC-40: plugin control plane visibility
      plugins: pluginRoster(),
    });
  }
  if (req.method === "GET" && req.url === "/queue") {
    return respond(200, { items: snapshot() });
  }
  // Polled by the session's PreToolUse hook: when a cancel is armed, the hook
  // denies non-console tools until the turn ends.
  if (req.method === "GET" && req.url === "/abort-check") {
    return respond(200, { abort: !!abortRequest, by: abortRequest?.by ?? null });
  }
  // Hit by the SessionStart hook (any matcher): binds the live transcript
  // the moment the session opens — the meter works before the first turn.
  if (req.method === "POST" && req.url === "/session-start") {
    return readBody((body) => {
      setTranscript(body.transcriptPath);
      respond(200, { ok: true });
    });
  }
  // Hit by the session's UserPromptSubmit hook: a typed turn began. The hook
  // forwards transcript_path — the ONLY source for which transcript is live.
  if (req.method === "POST" && req.url === "/turn-start") {
    return readBody((body) => {
      setTranscript(body.transcriptPath);
      onTurnStart();
      respond(200, { ok: true });
    });
  }
  // Hit by the session's Stop hook: the turn ended — dispatch the next command.
  if (req.method === "POST" && req.url === "/turn-end") {
    onTurnEnd();
    return respond(200, { ok: true });
  }
  // TNGC-32 hooks: PreCompact = consolidation is truly starting (the ACK for
  // an injected /compact, and the only signal for auto-compact);
  // SessionStart(compact) = it finished and the session is back.
  if (req.method === "POST" && req.url === "/compaction-start") {
    return readBody((body) => {
      setTranscript(body.transcriptPath);
      onCompactionStart(typeof body.trigger === "string" ? body.trigger : "unknown");
      respond(200, { ok: true });
    });
  }
  if (req.method === "POST" && req.url === "/compaction-end") {
    return readBody((body) => {
      setTranscript(body.transcriptPath); // compaction rolls to a new file
      onCompactionEnd();
      respond(200, { ok: true });
    });
  }
  // Local compaction trigger (same handler the cloud `compact` frame uses) —
  // loopback-only like everything else here.
  if (req.method === "POST" && req.url === "/compact") {
    return readBody((body) => {
      const result = requestCompaction(typeof body.by === "string" && body.by ? body.by : "local");
      respond(result.ok ? 202 : 409, result);
    });
  }
  // Local model/effort setter (same handler the cloud `set_pref` frame uses).
  if (req.method === "POST" && req.url === "/set-pref") {
    return readBody((body) => {
      const result = requestSetPref(
        typeof body.kind === "string" ? body.kind : "",
        body.value,
        typeof body.by === "string" && body.by ? body.by : "local",
      );
      respond(result.ok ? 202 : 400, result);
    });
  }
  if (req.method === "POST" && req.url === "/withdraw") {
    return readBody((body) => {
      if (typeof body.id !== "string") return respond(400, { error: "id is required" });
      const by = typeof body.by === "string" && body.by ? body.by : "local";
      const result = withdraw(body.id, by);
      respond(result.ok ? 202 : 404, result);
    });
  }
  if (req.method === "POST" && req.url === "/message") {
    return readBody((body) => {
      if (typeof body.transcript !== "string" || body.transcript.trim() === "") {
        return respond(400, { error: "transcript (non-empty string) is required" });
      }
      enqueue({
        user: typeof body.user === "string" && body.user ? body.user : "leif",
        device: typeof body.device === "string" && body.device ? body.device : "office",
        transcript: body.transcript.trim(),
        ts: Date.now(),
        ...(typeof body.wall === "string" && body.wall ? { wall: body.wall } : {}),
      });
      respond(202, { ok: true, mode: "channel-push", busy, queued: queue.length });
    });
  }
  respond(404, { error: "not found" });
});

http.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[bridge] port ${PORT} already in use — orphaned bridge? fix: fuser -k ${PORT}/tcp, then restart the session`,
    );
  } else {
    console.error(`[bridge] http error: ${err.message}`);
  }
  process.exit(1);
});
// Loopback by default; the Computer container sets TNG_BRIDGE_HOST=0.0.0.0 so
// Docker can publish the port back to the host's 127.0.0.1 (say.sh). Never
// bind 0.0.0.0 on a bare host — this endpoint is unauthenticated by design.
const HOST = process.env.TNG_BRIDGE_HOST ?? "127.0.0.1";
http.listen(PORT, HOST, () => {
  console.error(`[bridge] queue endpoint on http://${HOST}:${PORT} (channel push, ttl ${TTL_MS}ms)`);
});

// ---- the outbound Tricorder link ---------------------------------------------

let cloudState: "disabled" | "connecting" | "up" | "down" = "disabled";
let cloudSocket: WebSocket | null = null;

// ---- viewscreen roster (TNGC-35) -----------------------------------------------
// The PWA's wall selector lists the house's live viewscreens. The bridge is
// the only thing that talks to both sides, so it polls the console server
// (LAN, cheap, displays change rarely) and pushes changes up the link.

let lastRosterJson = "";
let lastRoster: RosterDisplay[] = [];

function sendRoster(force = false): void {
  if (cloudSocket?.readyState !== WebSocket.OPEN) return;
  if (!force && lastRosterJson === "") return;
  const frame: LinkUpFrame = { v: 1, type: "roster", displays: lastRoster };
  try {
    cloudSocket.send(JSON.stringify(frame));
  } catch {
    // link recycling — the open handler re-syncs
  }
}

async function pollRoster(): Promise<void> {
  try {
    const res = await fetch(`${SERVER_URL}/api/console/displays`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { displays?: RosterDisplay[] };
    const displays = data.displays ?? [];
    const json = JSON.stringify(displays);
    if (json === lastRosterJson) return;
    lastRosterJson = json;
    lastRoster = displays;
    sendRoster(true);
  } catch {
    // server restarting (tsx watch) — next poll catches up
  }
}
setInterval(() => void pollRoster(), 10_000).unref();
void pollRoster();

// ---- idle photo gallery (TNGC-64) ------------------------------------------------
// Opt-in screensaver: a wall named in TNG_GALLERY_WALLS that sits on the
// status board for IDLE_MS drifts into the ambient photo slideshow. The
// bridge is the right owner — it alone holds the cloud token (photo index)
// AND reaches the wall server. Hands-off rule: the moment a wall shows
// anything but status/our gallery, its idle clock resets — commands, alerts,
// and panels always win; the takeover only ever replaces the idle board.

const GALLERY_WALLS = (process.env.TNG_GALLERY_WALLS ?? "")
  .split(/[\s,]+/)
  .map((w) => w.trim())
  .filter(Boolean);
// `||` not `??`: compose passes an empty string when unset, and an empty
// string must mean "default", never "0ms".
const IDLE_GALLERY_MS = Number(process.env.TNG_IDLE_GALLERY_MS || 10 * 60_000);
const GALLERY_PHOTO_CACHE_MS = 10 * 60_000;

const idleSince = new Map<string, number>();
let galleryPhotoCache: { at: number; photos: Array<Record<string, unknown>> } | null = null;

async function galleryPhotos(): Promise<Array<Record<string, unknown>>> {
  if (galleryPhotoCache && Date.now() - galleryPhotoCache.at < GALLERY_PHOTO_CACHE_MS) {
    return galleryPhotoCache.photos;
  }
  const { photos } = await cloudFetch<{
    photos: Array<{ url: string; takenAt: number; album: string | null }>;
  }>("GET", "/api/photos?limit=80");
  const mapped = photos.map((p) => ({ url: p.url, takenAt: p.takenAt, album: p.album }));
  galleryPhotoCache = { at: Date.now(), photos: mapped };
  return mapped;
}

async function pollIdleGallery(): Promise<void> {
  for (const wall of GALLERY_WALLS) {
    try {
      const res = await fetch(`${SERVER_URL}/api/console/screen?wall=${encodeURIComponent(wall)}`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) continue;
      const s = (await res.json()) as { view?: string };
      if (s.view === "gallery") continue; // ours (or someone's) — leave it be
      if (s.view !== "status") {
        idleSince.delete(wall); // the wall is in use — hands off, clock resets
        continue;
      }
      const since = idleSince.get(wall) ?? Date.now();
      if (!idleSince.has(wall)) idleSince.set(wall, since);
      if (Date.now() - since < IDLE_GALLERY_MS) continue;
      const photos = await galleryPhotos();
      idleSince.delete(wall);
      if (!photos.length) continue; // empty library — nothing to drift into
      await fetch(`${SERVER_URL}/api/console/display`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ view: "gallery", props: { photos, title: "MEMORIES" }, wall }),
        signal: AbortSignal.timeout(5_000),
      });
      console.error(`[bridge] idle gallery on ${wall} (${photos.length} photos)`);
    } catch {
      // wall server restarting / cloud blip — next poll catches up
    }
  }
}
if (GALLERY_WALLS.length && CLOUD_URL && CLOUD_TOKEN) {
  console.error(
    `[bridge] idle gallery armed for ${GALLERY_WALLS.join(", ")} after ${Math.round(IDLE_GALLERY_MS / 60_000)}min`,
  );
  setInterval(() => void pollIdleGallery(), 30_000).unref();
}

// ---- tricorder plugins (TNGC-40) ------------------------------------------------
// The deterministic control plane. `control` down-frames POST straight to the
// plugin sidecar — no queue, no session turn, dispatched even mid-turn: a
// lights toggle touches nothing the session owns, and making it wait behind a
// busy brain would recreate the latency this plane exists to remove. The
// bridge is also the availability truth: it probes the sidecar (the fence
// hole to lighting:7101 already exists for the lights MCP tool) and pushes
// roster + state changes up the link; the cloud never guesses.

const LIGHTING_URL = process.env.TNG_LIGHTING_URL ?? "http://lighting:7101";
/** Set by the claudeops plugin's compose fragment (TNGC-54). Unset = the
    household doesn't run the plugin: never probed, never in the roster. */
const CLAUDEOPS_URL = process.env.TNG_CLAUDEOPS_URL;

let lightsOnline = false;
let lightsState: LightsState | null = null;
let opsOnline = false;
let opsState: Record<string, unknown> | null = null;
/** Media (TNGC-69) is a BUILT-IN control plugin, not an installed sidecar:
    its "service" is the wall server this bridge already drives. Online =
    that server answered, so it is effectively always on in a running house. */
let mediaOnline = false;
let mediaState: MediaState | null = null;
let lastPluginsJson = "";
let lastLightsJson = "";
let lastOpsJson = "";
let lastMediaJson = "";

// ---- plugin tiles (TNGC-58) ------------------------------------------------------
// How a plugin looks on the phone's plugin grid is the PLUGIN's business, so
// it is declared in the plugin's own manifest (`ui`) rather than hardcoded in
// core — a new plugin arrives with its color and glyph and needs no edit here.
// The manifest is house-authored content, not trusted markup: the icon travels
// as path DATA (validated against a strict charset, re-validated cloud-side)
// that the phone draws itself. A bad `ui` block never hides a working plugin —
// it costs the tile its look, loudly, and nothing else.

const PLUGINS_DIR =
  process.env.TNG_PLUGINS_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins");

const TILE_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const TILE_VIEWBOX_RE = /^[\d.\- ]{3,32}$/;
/** SVG path data: commands + numbers + separators. No parentheses, no url(),
    nothing that could carry script even if a future renderer got careless. */
const TILE_PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz\d.,\-\s]{1,600}$/;
const MAX_TILE_PATHS = 12;

/** Validate and REBUILD a manifest `ui` block — never pass one through. */
export function parseTile(raw: unknown, id: string): PluginTile | undefined {
  const ui = raw as { color?: unknown; icon?: unknown } | undefined;
  if (!ui || typeof ui !== "object") {
    console.error(`[bridge] plugin ${id}: manifest has no "ui" block — tile falls back to the default look`);
    return undefined;
  }
  const color = typeof ui.color === "string" ? ui.color.trim() : "";
  const icon = ui.icon as { viewBox?: unknown; paths?: unknown; fill?: unknown } | undefined;
  if (!TILE_COLOR_RE.test(color)) {
    console.error(`[bridge] plugin ${id}: ui.color must be "#rrggbb" — tile falls back to the default look`);
    return undefined;
  }
  if (!icon || !Array.isArray(icon.paths) || icon.paths.length === 0 || icon.paths.length > MAX_TILE_PATHS) {
    console.error(`[bridge] plugin ${id}: ui.icon.paths must be 1..${MAX_TILE_PATHS} SVG paths — tile falls back`);
    return undefined;
  }
  const paths = icon.paths.filter((p): p is string => typeof p === "string" && TILE_PATH_RE.test(p.trim())).map((p) => p.trim());
  if (paths.length !== icon.paths.length) {
    console.error(`[bridge] plugin ${id}: ui.icon.paths contains path data that failed validation — tile falls back`);
    return undefined;
  }
  const viewBox = typeof icon.viewBox === "string" && TILE_VIEWBOX_RE.test(icon.viewBox.trim())
    ? icon.viewBox.trim()
    : "0 0 24 24";
  return { color: color.toLowerCase(), icon: { viewBox, paths, ...(icon.fill === true ? { fill: true } : {}) } };
}

/** Roster id → the plugin FOLDER that ships it. They are not always the same
    word: the `lighting` plugin exposes the control-plane plugin `lights`, and
    looking up plugins/lights/ silently cost that tile its color (TNGC-58).
    A roster id absent here is assumed to name its own folder. */
const TILE_MANIFEST_DIR: Record<string, string> = { lights: "lighting" };

/** Manifests change only on deploy — read once, remember the verdict. */
const tileCache = new Map<string, PluginTile | undefined>();

export function pluginTile(id: string): PluginTile | undefined {
  if (tileCache.has(id)) return tileCache.get(id);
  const dir = TILE_MANIFEST_DIR[id] ?? id;
  let tile: PluginTile | undefined;
  try {
    const manifest = JSON.parse(readFileSync(join(PLUGINS_DIR, dir, "plugin.json"), "utf8")) as { ui?: unknown };
    tile = parseTile(manifest.ui, id);
  } catch {
    console.error(`[bridge] plugin ${id}: no readable ${join(PLUGINS_DIR, dir, "plugin.json")} — tile falls back`);
  }
  tileCache.set(id, tile);
  return tile;
}

/** Media's tile (TNGC-69) is declared HERE, not in a manifest, because media
    has no plugins/ folder to hold one: it is core plumbing exposed as a
    plugin so it inherits the enable switch, the guest exclusion, and the
    attribution log. Lucide "list-music": a queue with a note. */
const MEDIA_TILE: PluginTile = {
  color: "#cc99cc",
  icon: {
    viewBox: "0 0 24 24",
    paths: ["M21 15V6", "M18.5 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z", "M12 12H3", "M16 6H3", "M12 18H3"],
  },
};

function pluginRoster(): PluginStatus[] {
  const entry = (id: string, name: string, online: boolean): PluginStatus => {
    const tile = pluginTile(id);
    return { id, name, online, ...(tile ? { tile } : {}) };
  };
  return [
    entry("lights", "Lights", lightsOnline),
    { id: "media", name: "Media", online: mediaOnline, tile: MEDIA_TILE },
    ...(CLAUDEOPS_URL ? [entry("claudeops", "Claude Ops", opsOnline)] : []),
  ];
}

function sendPlugins(): void {
  if (cloudSocket?.readyState !== WebSocket.OPEN) return;
  const frame: LinkUpFrame = { v: 1, type: "plugins", plugins: pluginRoster() };
  try {
    cloudSocket.send(JSON.stringify(frame));
  } catch {
    // link recycling — the open handler re-syncs
  }
}

function sendLightsState(): void {
  if (!lightsState || cloudSocket?.readyState !== WebSocket.OPEN) return;
  const frame: LinkUpFrame = { v: 1, type: "plugin_state", plugin: "lights", state: lightsState };
  try {
    cloudSocket.send(JSON.stringify(frame));
  } catch {
    // link recycling — the open handler re-syncs
  }
}

function sendOpsState(): void {
  if (!opsState || cloudSocket?.readyState !== WebSocket.OPEN) return;
  const frame: LinkUpFrame = { v: 1, type: "plugin_state", plugin: "claudeops", state: opsState };
  try {
    cloudSocket.send(JSON.stringify(frame));
  } catch {
    // link recycling — the open handler re-syncs
  }
}

function sendMediaState(): void {
  if (!mediaState || cloudSocket?.readyState !== WebSocket.OPEN) return;
  const frame: LinkUpFrame = { v: 1, type: "plugin_state", plugin: "media", state: mediaState };
  try {
    cloudSocket.send(JSON.stringify(frame));
  } catch {
    // link recycling — the open handler re-syncs
  }
}

async function pollPlugins(force = false): Promise<void> {
  let online = false;
  try {
    const res = await fetch(`${LIGHTING_URL}/health`, { signal: AbortSignal.timeout(3_000) });
    online = res.ok;
  } catch {
    online = false;
  }
  if (online) {
    try {
      const res = await fetch(`${LIGHTING_URL}/state`, { signal: AbortSignal.timeout(4_000) });
      if (res.ok) {
        const s = (await res.json()) as {
          devices?: Array<{
            name?: unknown;
            available?: unknown;
            on?: unknown;
            brightnessPct?: unknown;
            color?: { hex?: unknown; label?: unknown } | null;
          }>;
        };
        const fixtures = (s.devices ?? [])
          .filter((d) => typeof d.name === "string")
          .slice(0, 64)
          .map((d) => ({
            name: d.name as string,
            available: d.available !== false,
            on: d.on === true,
            brightnessPct: typeof d.brightnessPct === "number" ? d.brightnessPct : null,
            color:
              d.color && typeof d.color.hex === "string" && typeof d.color.label === "string"
                ? { hex: d.color.hex, label: d.color.label }
                : null,
          }));
        const fj = JSON.stringify(fixtures);
        if (force || fj !== lastLightsJson) {
          lastLightsJson = fj;
          lightsState = { fixtures, updatedAt: Date.now() };
          sendLightsState();
        }
      }
    } catch {
      // sidecar mid-restart — keep the last snapshot, health already said online
    }
  }
  lightsOnline = online;

  // claudeops (TNGC-54): the ops-agent on the host, when the plugin is on.
  if (CLAUDEOPS_URL) {
    let ops = false;
    try {
      const res = await fetch(`${CLAUDEOPS_URL}/health`, { signal: AbortSignal.timeout(3_000) });
      ops = res.ok;
    } catch {
      ops = false;
    }
    if (ops) {
      try {
        const res = await fetch(`${CLAUDEOPS_URL}/state`, { signal: AbortSignal.timeout(4_000) });
        if (res.ok) {
          const s = (await res.json()) as Record<string, unknown>;
          delete s.ok;
          const sj = JSON.stringify(s);
          if (force || sj !== lastOpsJson) {
            lastOpsJson = sj;
            opsState = s;
            sendOpsState();
          }
        }
      } catch {
        // agent mid-restart — keep the last snapshot, health already said online
      }
    }
    opsOnline = ops;
  }

  await pollMedia(force);

  const pj = JSON.stringify(pluginRoster());
  if (force || pj !== lastPluginsJson) {
    lastPluginsJson = pj;
    sendPlugins();
  }
}

/** media (TNGC-69): the wall server's own transport state. No health probe of
    its own — the media-state read IS the probe. Runs on its OWN short beat
    rather than the 15s plugin sweep: a transport bar that takes 15 seconds to
    notice a track change reads as broken, and this is one loopback GET against
    a process the bridge already talks to constantly. Pushes are change-gated,
    so a quiet house sends nothing up the link no matter how often we look. */
async function pollMedia(force = false): Promise<void> {
  try {
    const res = await fetch(`${SERVER_URL}/api/console/media-state`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) {
      mediaOnline = false;
      return;
    }
    const s = (await res.json()) as { walls?: unknown; primary?: unknown };
    const walls = Array.isArray(s.walls) ? (s.walls as MediaState["walls"]).slice(0, 16) : [];
    const primary = typeof s.primary === "string" ? s.primary : "";
    // Compare WITHOUT updatedAt, or every beat would look like a change and
    // push a frame for a house where nothing is happening.
    const mj = JSON.stringify({ walls, primary });
    if (force || mj !== lastMediaJson) {
      lastMediaJson = mj;
      mediaState = { walls, primary, updatedAt: Date.now() };
      sendMediaState();
    }
    mediaOnline = true;
  } catch {
    mediaOnline = false; // wall server restarting (tsx watch) — next beat heals
  }
}

setInterval(() => void pollPlugins(), 15_000).unref();
void pollPlugins();
setInterval(() => void pollMedia(), 4_000).unref();

// While the ops session is mid-turn the phone is watching for "finished" —
// tighten the loop so the idle transition + result summary land in seconds,
// not at the next 15s beat. Host-local HTTP; the push is change-gated anyway.
if (CLAUDEOPS_URL) {
  setInterval(() => {
    const status = opsState?.status;
    if (status === "working" || status === "compacting") void pollPlugins();
  }, 3_000).unref();
}

/** Whitelist-rebuild of a lights `/set` body. The Worker validated already,
    but the bridge trusts nothing that rode the internet — same posture as
    set_pref: the sidecar request is BUILT from the values, never relayed. */
/** Scene names the house will accept from a phone (TNGC-67). Hand-kept in
    step with SCENES in plugins/lighting/service/src/control.mjs, same as the
    Worker's copy — two gates, and the sidecar 404s anything past both. */
const LIGHT_SCENES = ["default", "evening", "movie", "all-off", "red-alert", "party", "reset"];

function lightsSetBody(args: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (typeof args.target === "string" && args.target.length > 0 && args.target.length <= 64) out.target = args.target;
  if (args.state === "on" || args.state === "off") out.state = args.state;
  if (typeof args.brightness === "number" && args.brightness >= 0 && args.brightness <= 100) {
    out.brightness = Math.round(args.brightness);
  }
  if (typeof args.color === "string" && /^[#a-zA-Z0-9 -]{1,32}$/.test(args.color)) out.color = args.color;
  if (typeof args.colorTemp === "number" && args.colorTemp >= 2000 && args.colorTemp <= 6500) {
    out.colorTemp = Math.round(args.colorTemp);
  } else if (args.colorTemp === "warm" || args.colorTemp === "neutral" || args.colorTemp === "cool") {
    out.colorTemp = args.colorTemp;
  }
  if (typeof args.transition === "number" && args.transition >= 0 && args.transition <= 30) {
    out.transition = args.transition;
  }
  // A body with only a target does nothing — require at least one actual change.
  return Object.keys(out).some((k) => k !== "target" && k !== "transition") ? out : null;
}

async function executeControl(ctl: CloudControlCommand): Promise<void> {
  // Same ephemerality as voice: a control op that aged out in transit must
  // die, not fire — nobody wants the lights obeying an hour-old tap.
  if (Date.now() - ctl.ts > TTL_MS) {
    console.error(`[bridge] dropped stale control op (${Math.round((Date.now() - ctl.ts) / 1000)}s old) from ${ctl.user}`);
    return;
  }
  // A named scene (TNGC-67). Re-validated here, never passed through: the
  // Worker's whitelist is the first gate, this is the second, and the sidecar
  // 404s anything neither knew about.
  if (ctl.plugin === "lights" && ctl.op === "scene") {
    const raw = (ctl.args ?? {}).scene;
    const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!LIGHT_SCENES.includes(name)) {
      console.error(`[bridge] refused lights scene "${String(raw)}" from ${ctl.user}`);
      return;
    }
    const target = (ctl.args ?? {}).target;
    const body: Record<string, unknown> = { name };
    if (typeof target === "string" && target.length > 0 && target.length <= 64) body.target = target;
    try {
      const res = await fetch(`${LIGHTING_URL}/scene`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
      console.error(`[bridge] lights scene by ${ctl.user}/${ctl.device}: ${JSON.stringify(body)} → ${res.status}`);
    } catch (err) {
      console.error(`[bridge] lights scene failed: ${(err as Error).message}`);
    }
    setTimeout(() => void pollPlugins(true), 1_800).unref();
    return;
  }

  if (ctl.plugin === "lights" && ctl.op === "set") {
    const body = lightsSetBody(ctl.args ?? {});
    if (!body) {
      console.error(`[bridge] refused lights control from ${ctl.user} — no valid fields`);
      return;
    }
    try {
      const res = await fetch(`${LIGHTING_URL}/set`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
      console.error(`[bridge] lights control by ${ctl.user}/${ctl.device}: ${JSON.stringify(body)} → ${res.status}`);
    } catch (err) {
      console.error(`[bridge] lights control failed: ${(err as Error).message}`);
    }
    // The phone's confirmation is reported state, not the 200: re-read after
    // the fade has begun and push the fresh snapshot up the link.
    setTimeout(() => void pollPlugins(true), 1_200).unref();
    return;
  }

  // media (TNGC-69): transport control with no session in the loop. Every op
  // maps to a console route the wall server already exposes; the request is
  // BUILT from validated values, never relayed. `wall` is optional — absent
  // lets the server's own resolveWall rule pick (origin → primary).
  if (ctl.plugin === "media") {
    const args = ctl.args ?? {};
    const wall =
      typeof args.wall === "string" && args.wall.length > 0 && args.wall.length <= 64
        ? args.wall
        : undefined;
    let path: string | null = null;
    let body: Record<string, unknown> | null = null;
    if (ctl.op === "next") {
      path = "/api/console/queue";
      body = { action: "skip" };
    } else if (ctl.op === "prev") {
      path = "/api/console/queue";
      body = { action: "prev" };
    } else if (ctl.op === "jump") {
      const index = args.index;
      if (typeof index === "number" && Number.isInteger(index) && index >= 0 && index < 25) {
        path = "/api/console/queue";
        body = { action: "jump", index };
      }
    } else if (ctl.op === "loop") {
      if (typeof args.enabled === "boolean") {
        path = "/api/console/queue";
        body = { action: "loop", enabled: args.enabled };
      }
    } else if (
      ctl.op === "pause" ||
      ctl.op === "play" ||
      ctl.op === "stop" ||
      ctl.op === "volume_up" ||
      ctl.op === "volume_down"
    ) {
      path = "/api/console/media";
      body = { action: ctl.op };
    }
    // "Clear everything" is two server calls, so it is ONE op rather than two
    // frames: the phone can't half-apply it, it lands as a single attributed
    // action, and there is no window where playback stopped but the queue
    // survived. Stop first — clearing under a live player would just let the
    // queue drain into it.
    if (ctl.op === "clear") {
      const post = async (p: string, b: Record<string, unknown>) => {
        if (wall) b.wall = wall;
        const res = await fetch(`${SERVER_URL}${p}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(b),
          signal: AbortSignal.timeout(8_000),
        });
        return res.status;
      };
      try {
        const s1 = await post("/api/console/media", { action: "stop" });
        const s2 = await post("/api/console/queue", { action: "clear" });
        console.error(`[bridge] media clear by ${ctl.user}/${ctl.device} → stop ${s1}, clear ${s2}`);
      } catch (err) {
        console.error(`[bridge] media clear failed: ${(err as Error).message}`);
      }
      setTimeout(() => void pollMedia(true), 900).unref();
      return;
    }
    if (!path || !body) {
      console.error(`[bridge] refused media control ${ctl.op} from ${ctl.user} — invalid op or args`);
      return;
    }
    if (wall) body.wall = wall;
    try {
      const res = await fetch(`${SERVER_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
      console.error(`[bridge] media ${ctl.op} by ${ctl.user}/${ctl.device} → ${res.status}`);
    } catch (err) {
      console.error(`[bridge] media ${ctl.op} failed: ${(err as Error).message}`);
    }
    // Confirmation is REPORTED state, not the 200 — re-read and push so the
    // phone's buttons settle on truth about a second after the tap.
    setTimeout(() => void pollMedia(true), 900).unref();
    return;
  }

  // claudeops (TNGC-54): remote ops of the host's claude-ops session. The
  // Worker already enforced ADMIN and validated; rebuilt from values anyway.
  if (ctl.plugin === "claudeops" && CLAUDEOPS_URL) {
    const args = ctl.args ?? {};
    let path: string | null = null;
    let body: Record<string, unknown> | null = null;
    if (ctl.op === "send") {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (text.length >= 1 && text.length <= 4000) {
        path = "/command";
        body = { text, user: ctl.user, device: ctl.device };
      }
    } else if (ctl.op === "compact") {
      path = "/compact";
      body = { by: ctl.user };
    } else if (ctl.op === "set_pref") {
      const kind = args.kind;
      const value = args.value;
      const valid =
        typeof value === "string" &&
        ((kind === "effort" && (EFFORT_LEVELS as readonly string[]).includes(value)) ||
          (kind === "model" && MODEL_VALUE_RE.test(value)));
      if (valid) {
        path = "/set-pref";
        body = { kind, value };
      }
    }
    if (!path || !body) {
      console.error(`[bridge] refused claudeops control ${ctl.op} from ${ctl.user} — invalid op or args`);
      return;
    }
    try {
      const res = await fetch(`${CLAUDEOPS_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
      console.error(`[bridge] claudeops ${ctl.op} by ${ctl.user}/${ctl.device} → ${res.status}`);
    } catch (err) {
      console.error(`[bridge] claudeops ${ctl.op} failed: ${(err as Error).message}`);
    }
    setTimeout(() => void pollPlugins(true), 1_200).unref();
    return;
  }

  console.error(`[bridge] refused control op ${ctl.plugin}/${ctl.op} — unknown plugin or op`);
}

// ---- tricorder viewscreens (TNGC-36) --------------------------------------------
// A phone in Viewscreen mode is one more named display whose transport is the
// cloud tunnel: the DO sends display_open/display_close, the bridge attaches
// a plain display client to the house hub under that name and relays every
// server→display message up as a `frame`. TTS is deferred — the bridge acks
// speak instantly and strips the audio payload, so captions render silently.

const SERVER_WS_URL = SERVER_URL.replace(/^http/, "ws") + "/ws";

interface TricorderDisplay {
  ws: WebSocket | null;
  retryTimer: NodeJS.Timeout | null;
  /** Frames relay through this promise chain so the async composite-asset
      inlining (below) can never reorder them. */
  relayChain: Promise<void>;
}
const tricorderDisplays = new Map<string, TricorderDisplay>();

/** TNGC-37: composite `svg` blocks reference same-origin LAN assets the
    phone can't fetch — inline them as data URIs before the frame rides the
    tunnel. Small caps, fail-open: an asset that won't inline stays a
    reference and the stage renders its placard. */
const INLINE_SVG_MAX_BYTES = 256 * 1024;

async function inlineCompositeSvgBlocks(blocks: unknown, depth = 0): Promise<void> {
  if (depth > 3 || !Array.isArray(blocks)) return;
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: unknown; assetUrl?: unknown; items?: unknown };
    if (b.type === "group") {
      await inlineCompositeSvgBlocks(b.items, depth + 1);
      continue;
    }
    if (b.type !== "svg" || typeof b.assetUrl !== "string" || !b.assetUrl.startsWith("/")) continue;
    try {
      const res = await fetch(`${SERVER_URL}${b.assetUrl}`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) continue;
      const body = Buffer.from(await res.arrayBuffer());
      if (body.byteLength === 0 || body.byteLength > INLINE_SVG_MAX_BYTES) continue;
      b.assetUrl = `data:image/svg+xml;base64,${body.toString("base64")}`;
    } catch {
      // unreachable/slow asset — leave the reference, the stage placards it
    }
  }
}

/**
 * Paint a wall with inline props from the cloud (TNGC-61).
 *
 * The DO throttles and only sends while the link is live, so this stays a
 * fire-and-forget POST. The view name is checked against a conservative shape
 * rather than a list: the house server rejects a view the wall can't draw, and
 * duplicating the panel registry in the bridge would rot.
 */
const WALL_VIEW_RE = /^[a-z][a-z0-9-]{0,31}$/;

async function paintWall(view: string, props: unknown, wall?: string): Promise<void> {
  if (!WALL_VIEW_RE.test(view)) {
    console.error(`[bridge] refused display_props for view "${view}"`);
    return;
  }
  try {
    await fetch(`${SERVER_URL}/api/console/display`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ view, props: props ?? {}, ...(wall ? { wall } : {}) }),
      signal: AbortSignal.timeout(4_000),
    });
  } catch {
    // The wall is a bonus surface for a cloud game, never a dependency —
    // a dark television must not break play on the phones.
  }
}

function openTricorderDisplay(name: string): void {
  if (!/^tricorder-[a-z0-9_-]{1,32}$/.test(name)) {
    console.error(`[bridge] refused display_open for non-tricorder name "${name}"`);
    return;
  }
  if (tricorderDisplays.has(name)) return;
  const entry: TricorderDisplay = { ws: null, retryTimer: null, relayChain: Promise.resolve() };
  tricorderDisplays.set(name, entry);
  connectTricorderDisplay(name, entry);
  console.error(`[bridge] viewscreen ${name} attached`);
}

function connectTricorderDisplay(name: string, entry: TricorderDisplay): void {
  if (!tricorderDisplays.has(name)) return;
  const ws = new WebSocket(SERVER_WS_URL, { handshakeTimeout: 5_000 });
  entry.ws = ws;
  let retried = false;
  const retry = () => {
    if (retried) return;
    retried = true;
    entry.ws = null;
    if (!tricorderDisplays.has(name)) return; // closed while dying — done
    entry.retryTimer = setTimeout(() => connectTricorderDisplay(name, entry), 3_000);
  };
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", role: "display", display: name }));
  });
  ws.on("message", (data) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    // Behave like a real wall so the hub's state stays truthful: echo the
    // screen we now "show", and complete speaks immediately (no audio path —
    // the phone renders the caption on its own clock).
    if (msg.type === "display") {
      ws.send(JSON.stringify({ type: "screen_state", view: msg.view, props: msg.props }));
    }
    if (msg.type === "speak") {
      ws.send(JSON.stringify({ type: "speak_done", utteranceId: msg.utteranceId }));
      delete msg.audioUrl;
      delete msg.timing;
    }
    // Forward through the per-display chain: composite frames pause to inline
    // their svg assets (TNGC-37), and everything queues behind them so frame
    // order on the phone always matches the house.
    entry.relayChain = entry.relayChain
      .then(async () => {
        if (msg.type === "display" && msg.view === "composite" && msg.props && typeof msg.props === "object") {
          await inlineCompositeSvgBlocks((msg.props as { blocks?: unknown }).blocks);
        }
        if (cloudSocket?.readyState === WebSocket.OPEN) {
          const frame: LinkUpFrame = { v: 1, type: "frame", display: name, msg };
          cloudSocket.send(JSON.stringify(frame));
        }
      })
      .catch(() => {
        // link recycling — the phone re-syncs when the DO re-opens us
      });
  });
  ws.on("close", retry);
  ws.on("error", () => {
    ws.terminate();
    retry();
  });
}

/** Phone-reported player events (video_ended / video_error) forwarded onto
    the display's socket — the hub resolves the wall from the socket, so the
    per-wall play queue advances exactly as it would for a room wall.
    Whitelisted again here: a compromised cloud must not speak as a wall. */
function forwardDisplayClient(name: string, msg: unknown): void {
  const entry = tricorderDisplays.get(name);
  if (!entry?.ws || entry.ws.readyState !== WebSocket.OPEN) return;
  const m = msg as { type?: unknown; videoId?: unknown; code?: unknown; audio?: unknown };
  if (m?.type !== "video_ended" && m?.type !== "video_error") return;
  if (typeof m.videoId !== "string") return;
  const clean =
    m.type === "video_ended"
      ? { type: "video_ended", videoId: m.videoId }
      : {
          type: "video_error",
          videoId: m.videoId,
          ...(typeof m.code === "number" ? { code: m.code } : {}),
          ...(m.audio === true ? { audio: true } : {}),
        };
  try {
    entry.ws.send(JSON.stringify(clean));
  } catch {
    // socket recycling — the retry loop will reattach
  }
}

function closeTricorderDisplay(name: string): void {
  const entry = tricorderDisplays.get(name);
  if (!entry) return;
  tricorderDisplays.delete(name);
  if (entry.retryTimer) clearTimeout(entry.retryTimer);
  entry.ws?.close();
  console.error(`[bridge] viewscreen ${name} detached`);
}

function closeAllTricorderDisplays(): void {
  for (const name of [...tricorderDisplays.keys()]) closeTricorderDisplay(name);
}

function startCloudLink() {
  if (!CLOUD_URL || !CLOUD_TOKEN) {
    console.error(
      "[bridge] no tricorder link configured (TNG_TRICORDER_URL / TNG_TRICORDER_TOKEN unset) — local-only mode",
    );
    return;
  }
  let attempt = 0;

  const connect = () => {
    cloudState = "connecting";
    const ws = new WebSocket(CLOUD_URL, {
      headers: { authorization: `Bearer ${CLOUD_TOKEN}` },
      handshakeTimeout: 10_000,
    });
    cloudSocket = ws;
    let lastActivity = Date.now();
    let keepalive: NodeJS.Timeout | null = null;
    let retried = false;

    const retry = () => {
      if (retried) return;
      retried = true;
      cloudState = "down";
      cloudSocket = null;
      if (keepalive) clearInterval(keepalive);
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 6));
      console.error(`[bridge] tricorder link down — retrying in ${Math.round(delay / 1000)}s`);
      setTimeout(connect, delay);
    };

    ws.on("open", () => {
      attempt = 0;
      cloudState = "up";
      lastActivity = Date.now();
      console.error("[bridge] tricorder link up");
      // Re-sync queue state after a link blip (frames sent while down are
      // lost — the snapshot, unlike messages, has no replay).
      pushState();
      sendRoster(true);
      sendComputerInfo(true);
      // Plugins (TNGC-40): the DO cleared its stored roster/state for the new
      // link — re-send what we know now, then re-probe for freshness.
      sendPlugins();
      sendLightsState();
      sendOpsState();
      void pollPlugins(true);
      // App-level keepalive: the DO answers "ping" with "pong" without waking.
      keepalive = setInterval(() => {
        if (Date.now() - lastActivity > 90_000) {
          console.error("[bridge] tricorder link silent >90s — recycling");
          ws.terminate();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, 30_000);
    });

    ws.on("message", (data) => {
      lastActivity = Date.now();
      const text = data.toString();
      if (text === "pong") return;
      try {
        const frame = JSON.parse(text) as LinkDownFrame;
        if (frame.type === "msg" && firstSighting(frame.msg.id)) {
          const { id, ...msg } = frame.msg;
          enqueue({ ...msg, cloudId: id });
        } else if (frame.type === "withdraw" && typeof frame.id === "string") {
          withdraw(frame.id, typeof frame.by === "string" ? frame.by : "tricorder");
        } else if (frame.type === "display" && firstSighting(frame.cmd.id)) {
          const cmd = frame.cmd;
          enqueue({
            user: cmd.user,
            device: cmd.device,
            transcript: `Display: ${cmd.title}`,
            ts: cmd.ts,
            cloudId: cmd.id,
            kind: "display",
            itemId: cmd.itemId,
            ...(cmd.wall ? { wall: cmd.wall } : {}),
          });
        } else if (frame.type === "display_open" && typeof frame.name === "string") {
          openTricorderDisplay(frame.name);
        } else if (frame.type === "display_close" && typeof frame.name === "string") {
          closeTricorderDisplay(frame.name);
        } else if (frame.type === "display_client" && typeof frame.name === "string") {
          forwardDisplayClient(frame.name, frame.msg);
        } else if (frame.type === "compact") {
          // Admin pressed Compact in the PWA (worker enforced the role).
          const result = requestCompaction(typeof frame.by === "string" && frame.by ? frame.by : "tricorder");
          console.error(`[bridge] cloud compact request: ${result.state}`);
        } else if (frame.type === "set_pref") {
          // Admin set model/effort in the PWA (worker validated; re-validated
          // inside — the injected line is built from the value, never trusted).
          const result = requestSetPref(frame.kind, frame.value, typeof frame.by === "string" && frame.by ? frame.by : "tricorder");
          console.error(`[bridge] cloud set_pref ${frame.kind}: ${result.state}`);
        } else if (frame.type === "control" && frame.ctl && typeof frame.ctl === "object") {
          // Deterministic plugin op (TNGC-40): straight to the sidecar, even
          // mid-turn — never queued, never near the session.
          void executeControl(frame.ctl);
        } else if (frame.type === "display_props" && typeof frame.view === "string") {
          // Cloud machinery painting a wall (TNGC-61): a game board, right
          // now, no library item and no session turn. Straight to the same
          // console route the bridge already posts to elsewhere.
          void paintWall(frame.view, frame.props, typeof frame.wall === "string" ? frame.wall : undefined);
        }
      } catch {
        // unknown frame — ignore (forward compatibility)
      }
    });

    ws.on("close", () => {
      // Frames can't ride a dead link; the DO re-opens active viewscreens on
      // reconnect, so drop them now and the roster stays honest.
      closeAllTricorderDisplays();
      retry();
    });
    ws.on("error", (err) => {
      console.error(`[bridge] tricorder link error: ${err.message}`);
      retry();
    });
  };

  connect();
}

startCloudLink();

// ---- read-only diagnostics tool ----------------------------------------------

server.registerTool(
  "peek_messages",
  {
    description:
      "Read-only diagnostics for the voice-command pipeline. Returns link state, the current " +
      "queue, and the last 20 messages the bridge received, with whether each was pushed as a " +
      "channel event. Use ONLY when debugging ('did my command reach the bridge?') — never to " +
      "receive commands; commands arrive on their own as channel events.",
    inputSchema: {},
  },
  async () => ({
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          cloud: cloudState,
          delivered,
          deliveryFailures,
          busy,
          queue: snapshot(),
          recent,
        }),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
console.error("[bridge] MCP server connected (stdio, channel capability declared)");

// Exit when the stdio pipe dies (session gone). Without this, a killed parent
// pnpm orphans the tsx child, which keeps holding the port AND the cloud
// socket — the wall looks "online" with no brain attached (claude-code#36730
// class of wart; also why `make down` kills by port, not pattern).
const shutdown = () => {
  console.error("[bridge] stdin closed — shutting down");
  process.exit(0);
};
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
