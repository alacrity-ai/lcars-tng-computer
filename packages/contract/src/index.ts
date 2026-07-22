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

/** Frames pushed down the /link socket (cloud → bridge). Keepalive is raw
    text "ping"/"pong" outside this framing (DO auto-response, never wakes
    the hub). */
export type LinkDownFrame = { v: typeof CONTRACT_VERSION; type: "msg"; msg: CloudMessage };

/** Frames sent up the /link socket (bridge → cloud). An ack means the
    message was handed to the session (returned by await_message); the hub
    deletes it and will never replay it. */
export type LinkUpFrame = { v: typeof CONTRACT_VERSION; type: "ack"; id: string };
