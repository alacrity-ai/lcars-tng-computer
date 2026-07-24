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
    All additive in v1 — both ends ignore unknown frame types. */
export type LinkDownFrame =
  | { v: typeof CONTRACT_VERSION; type: "msg"; msg: CloudMessage }
  | { v: typeof CONTRACT_VERSION; type: "withdraw"; id: string; by?: string }
  | { v: typeof CONTRACT_VERSION; type: "display"; cmd: CloudDisplayCommand }
  | { v: typeof CONTRACT_VERSION; type: "display_open"; name: string }
  | { v: typeof CONTRACT_VERSION; type: "display_close"; name: string };

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
    Additive in v1: both ends ignore unknown frame types. */
export type LinkUpFrame =
  | { v: typeof CONTRACT_VERSION; type: "ack"; id: string }
  | { v: typeof CONTRACT_VERSION; type: "pending"; count: number }
  | { v: typeof CONTRACT_VERSION; type: "queue"; items: QueueItem[] }
  | { v: typeof CONTRACT_VERSION; type: "roster"; displays: RosterDisplay[] }
  | { v: typeof CONTRACT_VERSION; type: "frame"; display: string; msg: unknown };
