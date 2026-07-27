/**
 * The cross-boundary message contract (TNGC-14).
 *
 * Everything the Tricorder cloud and the home bridge agree on lives here and
 * ONLY here. Keep it tiny: this is the one interface whose change breaks two
 * deployables at once. Bump CONTRACT_VERSION on any shape change.
 */
export const CONTRACT_VERSION = 1;

/** A single utterance, fully attributed. `ts` is enqueue time (epoch ms).
    TNGC-35 (additive): `wall` is the viewscreen the sender's tricorder was
    targeting — absent means "let the Computer default" (origin/primary). */
export interface TngMessage {
  user: string;
  device: string;
  transcript: string;
  ts: number;
  wall?: string;
}

/** A message as persisted/relayed by the cloud queue. */
export interface CloudMessage extends TngMessage {
  id: string;
}

/** One row of the bridge's dispatcher queue as published to the cloud
    (TNGC-22). `active` marks the command the session is working right now;
    `cancelling` means its abort flag is armed. Transcripts are truncated by
    the bridge before framing.
    TNGC-23 (additive): `kind` distinguishes a library display command from a
    transcript (absent = transcript); for displays, `transcript` carries the
    item title and `itemId` the library item — never the payload. */
export interface QueueItem {
  id: string;
  user: string;
  device: string;
  transcript: string;
  ts: number;
  active?: boolean;
  cancelling?: boolean;
  kind?: "transcript" | "display";
  itemId?: string;
  /** TNGC-35 (additive): the targeted viewscreen, for `user → wall` rows. */
  wall?: string;
}

/** A library display command as persisted/relayed by the cloud queue
    (TNGC-23): metadata ONLY — the bridge fetches the payload from the cloud
    at dispatch time, so frames, DO storage, and queue snapshots stay tiny.
    `title` is for the visible queue; `view` lets the bridge sanity-check. */
export interface CloudDisplayCommand {
  id: string;
  itemId: string;
  view: string;
  title: string;
  user: string;
  device: string;
  ts: number;
  /** TNGC-35 (additive): the viewscreen "Display on wall" should paint. */
  wall?: string;
}

/** TNGC-35: one live display as reported by the bridge's roster poll. */
export interface RosterDisplay {
  name: string;
  clients: number;
  primary?: boolean;
}

/** TNGC-32: the Computer session's health as reported by the bridge —
    context usage (read from the session transcript) and whether memory
    consolidation (/compact) is currently running. The hub stores the
    latest; the PWA admin console reads it. All fields best-effort. */
export interface ComputerInfo {
  context?: {
    tokens: number;
    window: number;
    percent: number;
  };
  /** The session's live model — the last assistant message's model id
      (updates on the first reply after a /model change). */
  model?: string;
  /** The persisted effort level ($CLAUDE_CONFIG_DIR/settings.json). */
  effort?: string;
  compacting: boolean;
  /** Epoch ms when the bridge computed this. */
  updatedAt: number;
}

// ---- session preferences (TNGC-32 follow-up) ----------------------------------
// THE canonical choice lists for the admin console's model/effort controls.
// Models change over time — edit exactly here; the worker validates against
// this and serves it to the PWA, the bridge builds the injected slash
// command from the validated value and nothing else.

export interface ModelChoice {
  /** What `/model <value>` is given. Aliases ("opus") track the current
      default of a family across releases; explicit ids pin a variant. */
  value: string;
  label: string;
}

export const MODEL_CHOICES: readonly ModelChoice[] = [
  { value: "opus", label: "Opus 5 — the default" },
  { value: "claude-fable-5[1m]", label: "Fable 5 — deepest reasoning" },
  { value: "sonnet", label: "Sonnet 5 — fast and capable" },
  { value: "haiku", label: "Haiku 4.5 — fastest" },
] as const;

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultracode", "auto"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Custom model ids (models change over time): one shell-safe token — no
    whitespace or metacharacters can ever reach the injected command line. */
export const MODEL_VALUE_RE = /^[a-z0-9][a-z0-9.[\]-]{1,63}$/;

// ---- tricorder plugins (TNGC-40) ----------------------------------------------
// The deterministic control plane: basic operations (lights first) route
// phone → Worker/DO → bridge → plugin sidecar, never the session. The bridge
// probes each sidecar and reports the roster — the cloud never guesses what
// a house has installed.

/** How a plugin paints its tile on the tricorder's plugin grid (TNGC-58).
    Declared by the plugin itself in its manifest's `ui` block, carried up the
    link with the roster, and re-validated cloud-side before any phone sees it
    — a manifest is house-authored content, not trusted markup, so the icon is
    path DATA the phone draws, never an SVG string it renders. */
export interface PluginTile {
  /** Tile background, `#rrggbb`. The phone picks black or white lettering
      from its luminance. */
  color: string;
  /** SVG path data for the glyph, drawn inside `viewBox`. Stroked like a
      Lucide icon unless `fill` is set. */
  icon: { viewBox: string; paths: string[]; fill?: boolean };
}

/** One plugin as probed by the bridge (TNGC-40). `online` = the sidecar
    answered its health check just now. */
export interface PluginStatus {
  id: string;
  name: string;
  online: boolean;
  /** TNGC-58. Optional on the wire only so an older bridge still rosters —
      manifests are required to declare it; the phone falls back to a neutral
      tile when it is missing or fails validation. */
  tile?: PluginTile;
}

/** A plugin control op (TNGC-40). EPHEMERAL by design: no DO persistence,
    no queue entry, no replay — a lights toggle from an hour ago must die,
    not fire. The Worker validates args; the bridge re-validates and rebuilds
    the sidecar request from them (never a pass-through). */
export interface CloudControlCommand {
  id: string;
  plugin: string;
  op: string;
  args?: Record<string, unknown>;
  user: string;
  device: string;
  ts: number;
}

/** One lighting fixture as reported up the link (TNGC-40). `color` is the
    service's current-color read: {hex, label} — label is the human name
    ("4000K", "#FF0000"). */
export interface LightsFixture {
  name: string;
  available: boolean;
  on: boolean;
  brightnessPct: number | null;
  color: { hex: string; label: string } | null;
}

/** The lights plugin's `plugin_state` payload (TNGC-40). */
export interface LightsState {
  fixtures: LightsFixture[];
  updatedAt: number;
}

/** Frames pushed down the /link socket (cloud → bridge). Keepalive is raw
    text "ping"/"pong" outside this framing (DO auto-response, never wakes
    the hub).
    - msg: a phone command to enqueue.
    - withdraw: remove a queued command / cancel the active one (TNGC-22);
      `id` is the QueueItem id, `by` the requesting user handle.
    - display: put a saved library item on the wall (TNGC-23) — dispatched
      through the same visible queue, no session turn consumed.
    - display_open / display_close (TNGC-36): a tricorder entered/left
      Viewscreen mode — the bridge attaches/detaches a display client named
      `name` (tricorder-<user>) to the house hub and relays its frames up.
    - display_client (TNGC-36 follow-up): a Viewscreen-mode phone reporting
      player events (video_ended / video_error) — the bridge forwards `msg`
      to the house hub over that display's socket, which is what advances a
      playlist's per-wall queue on the phone. The DO whitelists the types.
    - compact (TNGC-32): an admin pressed Compact in the PWA — the bridge
      holds the dispatcher and injects /compact into the tmux-wrapped
      session. `by` is the requesting admin's handle (audit trail).
    - set_pref (TNGC-32 follow-up): an admin set the session model or
      effort — the bridge injects `/model <value>` / `/effort <value>`,
      value validated at the worker AND re-validated bridge-side.
    - control (TNGC-40): a deterministic plugin op — the bridge POSTs it to
      the plugin sidecar immediately (no queue, no session turn, even
      mid-turn). Ephemeral: never stored, never replayed.
    - display_props (TNGC-61): paint a wall with INLINE props, right now, from
      cloud machinery — no library item, no session turn. The bridge turns it
      into the POST /api/console/display it already makes elsewhere, so the
      house server needs no new route. Ephemeral like control: a game frame
      from a minute ago must die, not replay. Senders self-throttle.
    All additive in v1 — both ends ignore unknown frame types. */
export type LinkDownFrame =
  | { v: typeof CONTRACT_VERSION; type: "msg"; msg: CloudMessage }
  | { v: typeof CONTRACT_VERSION; type: "withdraw"; id: string; by?: string }
  | { v: typeof CONTRACT_VERSION; type: "display"; cmd: CloudDisplayCommand }
  | { v: typeof CONTRACT_VERSION; type: "display_open"; name: string }
  | { v: typeof CONTRACT_VERSION; type: "display_close"; name: string }
  | { v: typeof CONTRACT_VERSION; type: "display_client"; name: string; msg: unknown }
  | { v: typeof CONTRACT_VERSION; type: "compact"; by?: string }
  | { v: typeof CONTRACT_VERSION; type: "set_pref"; kind: "model" | "effort"; value: string; by?: string }
  | { v: typeof CONTRACT_VERSION; type: "control"; ctl: CloudControlCommand }
  | {
      v: typeof CONTRACT_VERSION;
      type: "display_props";
      view: string;
      props: unknown;
      /** Named wall; omitted paints the house default. */
      wall?: string;
    };

/** Frames sent up the /link socket (bridge → cloud).
    - ack: the message was dispatched to the session OR withdrawn; the hub
      deletes it and will never replay it.
    - pending: legacy count-only badge frame (TNGC-21) — superseded by
      `queue`, still accepted by the hub for old bridges.
    - queue: the full dispatcher snapshot (TNGC-22) — the hub stores the
      latest and serves it on /queue + counts it on /status.
    - roster (TNGC-35): the house's live viewscreen list — the hub stores the
      latest; the PWA's wall selector reads it from /status.
    - frame (TNGC-36): one server→display message for a tricorder viewscreen
      (`display` = tricorder-<user>) — the hub fans it out to that user's
      Viewscreen-mode sockets. Never stored; push-only.
    - computer (TNGC-32): the session's context usage + compaction state —
      the hub stores the latest for the admin console and the PWA badge.
    - plugins (TNGC-40): the bridge-probed plugin roster — the hub stores
      the latest; enablement is the cloud's half (tenant_plugins in D1).
    - plugin_state (TNGC-40): one plugin's live state snapshot (for lights:
      LightsState) — the hub stores the latest per plugin, the PWA's plugin
      screens poll it. Stale-on-offline like queue/roster.
    Additive in v1: both ends ignore unknown frame types. */
export type LinkUpFrame =
  | { v: typeof CONTRACT_VERSION; type: "ack"; id: string }
  | { v: typeof CONTRACT_VERSION; type: "pending"; count: number }
  | { v: typeof CONTRACT_VERSION; type: "queue"; items: QueueItem[] }
  | { v: typeof CONTRACT_VERSION; type: "roster"; displays: RosterDisplay[] }
  | { v: typeof CONTRACT_VERSION; type: "frame"; display: string; msg: unknown }
  | { v: typeof CONTRACT_VERSION; type: "computer"; info: ComputerInfo }
  | { v: typeof CONTRACT_VERSION; type: "plugins"; plugins: PluginStatus[] }
  | { v: typeof CONTRACT_VERSION; type: "plugin_state"; plugin: string; state: unknown };
