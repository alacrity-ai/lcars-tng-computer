/**
 * The cross-boundary message contract (TNGC-14).
 *
 * Everything the Tricorder cloud and the home bridge agree on lives here and
 * ONLY here. Keep it tiny: this is the one interface whose change breaks two
 * deployables at once. Bump CONTRACT_VERSION on any shape change.
 */
export const CONTRACT_VERSION = 1;

/** A single utterance, fully attributed. `ts` is enqueue time (epoch ms). */
export interface TngMessage {
  user: string;
  device: string;
  transcript: string;
  ts: number;
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
}

/** Frames pushed down the /link socket (cloud → bridge). Keepalive is raw
    text "ping"/"pong" outside this framing (DO auto-response, never wakes
    the hub).
    - msg: a phone command to enqueue.
    - withdraw: remove a queued command / cancel the active one (TNGC-22);
      `id` is the QueueItem id, `by` the requesting user handle.
    - display: put a saved library item on the wall (TNGC-23) — dispatched
      through the same visible queue, no session turn consumed.
    All additive in v1 — both ends ignore unknown frame types. */
export type LinkDownFrame =
  | { v: typeof CONTRACT_VERSION; type: "msg"; msg: CloudMessage }
  | { v: typeof CONTRACT_VERSION; type: "withdraw"; id: string; by?: string }
  | { v: typeof CONTRACT_VERSION; type: "display"; cmd: CloudDisplayCommand };

/** Frames sent up the /link socket (bridge → cloud).
    - ack: the message was dispatched to the session OR withdrawn; the hub
      deletes it and will never replay it.
    - pending: legacy count-only badge frame (TNGC-21) — superseded by
      `queue`, still accepted by the hub for old bridges.
    - queue: the full dispatcher snapshot (TNGC-22) — the hub stores the
      latest and serves it on /queue + counts it on /status. Additive in
      v1: both ends ignore unknown frame types. */
export type LinkUpFrame =
  | { v: typeof CONTRACT_VERSION; type: "ack"; id: string }
  | { v: typeof CONTRACT_VERSION; type: "pending"; count: number }
  | { v: typeof CONTRACT_VERSION; type: "queue"; items: QueueItem[] };
