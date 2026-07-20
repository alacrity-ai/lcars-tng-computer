/**
 * The wire protocol between the API server and the LCARS webapp, and the
 * REST shapes the console MCP server posts to the API server.
 *
 * Server → webapp messages ride the WebSocket; the webapp answers with
 * ClientMessage. Every panel the webapp can render is a PanelView; its props
 * are typed here so Claude-side tools, server, and webapp agree.
 */

// ---------- Panels ----------

export type PanelView =
  | "boot"
  | "status"
  | "text"
  | "alert"
  | "blank"
  | "now-playing"
  | "weather"
  | "calendar"
  | "web"
  | "chart";

export interface TextPanelProps {
  title?: string;
  body: string; // markdown-ish plain text; webapp renders line breaks
}

export interface AlertPanelProps {
  level: "yellow" | "red";
  title?: string;
  message?: string;
}

export interface StatusPanelProps {
  /** Optional lines to show on the idle board; webapp fills defaults. */
  lines?: string[];
}

export interface NowPlayingPanelProps {
  track: string;
  artist: string;
  album?: string;
  artUrl?: string;
  positionMs?: number;
  durationMs?: number;
  playing?: boolean;
}

/** Panels not yet built take free-form props. */
export type PanelProps = Record<string, unknown>;

// ---------- Chimes ----------

export type ChimeName = "acknowledge" | "complete" | "error" | "red-alert";

// ---------- Server → webapp ----------

export interface DisplayMessage {
  type: "display";
  view: PanelView;
  props: PanelProps;
}

export interface SpeakMessage {
  type: "speak";
  utteranceId: string;
  text: string;
  /** URL the webapp streams/plays; absent while TTS is offline (webapp shows caption only). */
  audioUrl?: string;
}

export interface ChimeMessage {
  type: "chime";
  name: ChimeName;
}

export type ServerMessage = DisplayMessage | SpeakMessage | ChimeMessage;

// ---------- Webapp → server ----------

export interface HelloMessage {
  type: "hello";
  role: "display";
}

export interface SpeakDoneMessage {
  type: "speak_done";
  utteranceId: string;
}

export interface ScreenStateMessage {
  type: "screen_state";
  view: PanelView;
  props: PanelProps;
}

export type ClientMessage = HelloMessage | SpeakDoneMessage | ScreenStateMessage;

// ---------- Console REST API (MCP server → API server) ----------

export interface DisplayRequest {
  view: PanelView;
  props?: PanelProps;
}

export interface SpeakRequest {
  text: string;
  /** Wait for playback to finish before the HTTP call returns (default true). */
  waitForPlayback?: boolean;
}

export interface ChimeRequest {
  name: ChimeName;
}

export interface ScreenStateResponse {
  view: PanelView;
  props: PanelProps;
  connectedDisplays: number;
}

export const DEFAULT_SERVER_PORT = 3789;
export const WS_PATH = "/ws";
