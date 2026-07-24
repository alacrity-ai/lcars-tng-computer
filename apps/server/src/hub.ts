import type { WebSocket } from "@fastify/websocket";
import type {
  ClientMessage,
  DisplayRosterEntry,
  PanelProps,
  PanelView,
  ServerMessage,
  Widget,
} from "@tng/shared";
import { DEFAULT_PRIMARY_DISPLAY, normalizeDisplayName } from "@tng/shared";

/** After this long on any non-exempt panel, the screen falls back to status. */
const IDLE_REVERT_MS = 2 * 60_000;
/** Views that never auto-revert: the idle board itself, alerts (which demand
 * attention until explicitly cleared), blank (an explicit screen-off), boot
 * (transitions on its own), and long-dwell content — a video playing or an
 * article mid-read must not snap back to the clock underneath the user.
 * (results is deliberately NOT exempt: if no result was picked in two
 * minutes, the search is over.) A quiz waits on the user's answer for as
 * long as they care to think — it must never snap away mid-question. */
const IDLE_EXEMPT_VIEWS: PanelView[] = [
  "status",
  "alert",
  "blank",
  "boot",
  "youtube",
  "article",
  "quiz",
];

/** Everything one named viewscreen carries (TNGC-35). Entries persist after
    their last client disconnects — a kiosk reload must find its screen where
    it left it — so the live ROSTER is "entries with clients", not "entries". */
interface DisplayEntry {
  name: string;
  clients: Set<WebSocket>;
  view: PanelView;
  props: PanelProps;
  /** Composed overlay list, per display (global sources like the pending-
      commands badge merge in from globalWidgetSources). */
  widgets: Widget[];
  widgetSources: Map<string, Widget[]>;
  /** TNGC-26, now per display: what this wall's persistent player plays. */
  playback: PanelProps | null;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Tracks connected display clients and per-viewscreen screen state (TNGC-35).
 * The server is the source of truth for "what is on each screen" so Claude's
 * screen_state tool answers without a webapp round trip.
 *
 * Routing model: every outbound message is addressed to ONE display
 * (broadcast) or to ALL of them (broadcastAll — red alerts, alarm fires,
 * voice state, the working indicator). The target defaults server-side:
 * explicit `wall` param → the origin wall of the command being served (the
 * bridge posts it at dispatch time) → the primary wall.
 */
export class DisplayHub {
  private displays = new Map<string, DisplayEntry>();
  /** Which display each connected socket is showing (unset until hello). */
  private socketDisplay = new Map<WebSocket, string>();
  /** Widget sources shown on EVERY display (the pending-commands badge). */
  private globalWidgetSources = new Map<string, Widget[]>();
  private speakWaiters = new Map<string, () => void>();
  /** TNGC-27: the Computer's voice — a persistent setting (console routes
      own the disk file; the hub owns the live value + broadcast). Global:
      one Computer, one voice, N mouths. */
  private voiceVolume = 100;
  private voiceMuted = false;
  /** The wall of the voice command currently being served (bridge-posted at
      dispatch, cleared at turn end). THE default that makes routing work
      with zero tool-schema knowledge. */
  private originWall: string | null = null;
  readonly primary: string;
  private videoErrorHandler:
    | ((wall: string, videoId: string, code?: number, audio?: boolean) => void)
    | undefined;
  private videoEndedHandler: ((wall: string, videoId: string) => void) | undefined;
  private displayObserver: ((wall: string, view: PanelView, props: PanelProps) => void) | undefined;

  constructor() {
    this.primary =
      normalizeDisplayName(process.env.TNG_PRIMARY_WALL ?? "") || DEFAULT_PRIMARY_DISPLAY;
    this.entry(this.primary); // the primary wall always exists
  }

  private entry(name: string): DisplayEntry {
    let e = this.displays.get(name);
    if (!e) {
      e = {
        name,
        clients: new Set(),
        view: "boot",
        props: {},
        widgets: [],
        widgetSources: new Map(),
        playback: null,
        idleTimer: undefined,
      };
      this.displays.set(name, e);
    }
    return e;
  }

  /** Explicit wall → origin wall → primary. The one resolution rule. */
  resolveWall(explicit?: unknown): string {
    if (typeof explicit === "string") {
      const name = normalizeDisplayName(explicit);
      if (name) return name;
    }
    return this.originWall ?? this.primary;
  }

  /** Bridge-posted origin of the command being served (null = none active). */
  setOrigin(wall: string | null) {
    this.originWall = wall ? normalizeDisplayName(wall) || null : null;
  }

  get origin(): string | null {
    return this.originWall;
  }

  /** Live displays only — entries with at least one connected client. */
  roster(): DisplayRosterEntry[] {
    const out: DisplayRosterEntry[] = [];
    for (const e of this.displays.values()) {
      if (e.clients.size === 0) continue;
      out.push({
        name: e.name,
        clients: e.clients.size,
        ...(e.name === this.primary ? { primary: true } : {}),
      });
    }
    return out.sort((a, b) => (a.primary ? -1 : b.primary ? 1 : a.name.localeCompare(b.name)));
  }

  hasClients(wall: string): boolean {
    return (this.displays.get(wall)?.clients.size ?? 0) > 0;
  }

  get totalClients(): number {
    return this.socketDisplay.size;
  }

  /** Called on every display broadcast — the panel history records through
      this tap (see PanelHistory), keeping the hub free of history concerns. */
  setDisplayObserver(handler: (wall: string, view: PanelView, props: PanelProps) => void) {
    this.displayObserver = handler;
  }

  /** Called when a display reports its video player errored (see
      VideoErrorMessage) — the youtube routes use this for the audio
      fallback and auto-advance. `audio` = the audio path itself failed. */
  setVideoErrorHandler(handler: (wall: string, videoId: string, code?: number, audio?: boolean) => void) {
    this.videoErrorHandler = handler;
  }

  /** Called when a display reports its video finished naturally — the
      youtube routes use this to start the next queued video. */
  setVideoEndedHandler(handler: (wall: string, videoId: string) => void) {
    this.videoEndedHandler = handler;
  }

  add(socket: WebSocket) {
    socket.on("close", () => this.leave(socket));
    socket.on("message", (raw: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.onClientMessage(socket, msg);
    });
    // State flows at hello (which carries the display name); a client that
    // never says hello is never joined and never painted.
  }

  /** Attach a socket to a named display and sync it to that screen. */
  private join(socket: WebSocket, name: string) {
    const prior = this.socketDisplay.get(socket);
    if (prior === name) return;
    if (prior) this.displays.get(prior)?.clients.delete(socket);
    const e = this.entry(name);
    e.clients.add(socket);
    this.socketDisplay.set(socket, name);
    this.send(socket, { type: "display_id", name, primary: name === this.primary });
    this.send(socket, { type: "display", view: e.view, props: e.props });
    const widgets = this.composedWidgets(e);
    if (widgets.length > 0) this.send(socket, { type: "widgets", widgets });
    this.send(socket, { type: "voice_state", volume: this.voiceVolume, muted: this.voiceMuted });
    // a wall reload mid-music resumes the track (position resets — accepted)
    if (e.playback) this.send(socket, { type: "playback", action: "track", props: e.playback });
  }

  private leave(socket: WebSocket) {
    const name = this.socketDisplay.get(socket);
    if (name) this.displays.get(name)?.clients.delete(socket);
    this.socketDisplay.delete(socket);
  }

  /** Re-designate a socket's display ("this box is now the basement den").
      When the move leaves the old display empty of clients, its state
      migrates to the new name (unless the new name already exists) — the
      renamed screen keeps its picture. */
  private setDisplay(socket: WebSocket, rawName: string) {
    const name = normalizeDisplayName(rawName);
    if (!name) return;
    const prior = this.socketDisplay.get(socket);
    if (prior === name) return;
    const old = prior ? this.displays.get(prior) : undefined;
    if (
      old &&
      old.clients.size === 1 &&
      old.clients.has(socket) &&
      !this.displays.has(name) &&
      prior !== this.primary
    ) {
      // sole client of a non-primary display → carry the state across
      this.displays.delete(old.name);
      old.name = name;
      this.displays.set(name, old);
      this.socketDisplay.set(socket, name);
      this.send(socket, { type: "display_id", name, primary: name === this.primary });
      return;
    }
    this.join(socket, name);
  }

  /** Voice rename: re-key a display's state and tell its clients to persist
      the new name. Errors are strings so the route can 4xx them. */
  renameDisplay(fromRaw: string, toRaw: string): { ok: true; from: string; to: string } | { error: string } {
    const from = normalizeDisplayName(fromRaw);
    const to = normalizeDisplayName(toRaw);
    if (!to) return { error: "new name is empty after normalization" };
    if (from === to) return { ok: true, from, to };
    const e = this.displays.get(from);
    if (!e) return { error: `no viewscreen named "${from}"` };
    if (this.displays.has(to)) return { error: `a viewscreen named "${to}" already exists` };
    if (from === this.primary) return { error: `"${from}" is the primary wall — set TNG_PRIMARY_WALL to move it` };
    this.displays.delete(from);
    e.name = to;
    this.displays.set(to, e);
    for (const c of e.clients) {
      this.socketDisplay.set(c, to);
      this.send(c, { type: "display_id", name: to, primary: false });
    }
    return { ok: true, from, to };
  }

  private send(socket: WebSocket, msg: ServerMessage) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }

  private onClientMessage(socket: WebSocket, msg: ClientMessage) {
    if (msg.type === "hello") {
      // Unnamed legacy clients land on the primary wall — a one-wall house
      // upgrades with zero behavior change.
      const name = normalizeDisplayName(msg.display ?? "") || this.primary;
      this.join(socket, name);
      return;
    }
    if (msg.type === "set_display") {
      this.setDisplay(socket, msg.name);
      return;
    }
    const wall = this.socketDisplay.get(socket);
    if (msg.type === "screen_state") {
      if (!wall) return;
      const e = this.entry(wall);
      e.view = msg.view;
      e.props = msg.props;
      this.armIdleRevert(e);
    } else if (msg.type === "speak_done") {
      this.speakWaiters.get(msg.utteranceId)?.();
      this.speakWaiters.delete(msg.utteranceId);
    } else if (msg.type === "video_error") {
      if (wall) this.videoErrorHandler?.(wall, msg.videoId, msg.code, msg.audio);
    } else if (msg.type === "video_ended") {
      if (wall) this.videoEndedHandler?.(wall, msg.videoId);
    }
  }

  private composedWidgets(e: DisplayEntry): Widget[] {
    return (["commands", "timers", "nowplaying", "queue"] as const).flatMap(
      (s) => this.globalWidgetSources.get(s) ?? e.widgetSources.get(s) ?? [],
    );
  }

  private pushWidgets(e: DisplayEntry) {
    e.widgets = this.composedWidgets(e);
    const payload = JSON.stringify({ type: "widgets", widgets: e.widgets });
    for (const c of e.clients) {
      if (c.readyState === c.OPEN) c.send(payload);
    }
  }

  /** Replace one producer's widgets and push the composed list. `wall` scopes
      the source to one display (timers, queue, nowplaying); "*" makes it a
      global source shown on every display (the pending-commands badge). */
  setWidgets(
    source: "commands" | "timers" | "queue" | "nowplaying",
    widgets: Widget[],
    wall: string | "*",
  ) {
    if (wall === "*") {
      if (widgets.length === 0) this.globalWidgetSources.delete(source);
      else this.globalWidgetSources.set(source, widgets);
      for (const e of this.displays.values()) this.pushWidgets(e);
      return;
    }
    const e = this.entry(wall);
    if (widgets.length === 0) e.widgetSources.delete(source);
    else e.widgetSources.set(source, widgets);
    this.pushWidgets(e);
  }

  /** Address one display: update its state and fan out to its clients. */
  broadcast(msg: ServerMessage, wall: string) {
    const e = this.entry(wall);
    if (msg.type === "display") {
      e.view = msg.view;
      e.props = msg.props;
      // A youtube display IS the playback session starting/changing in the
      // foreground; any other panel backgrounds it (badge appears). Only
      // clearPlayback() ends it.
      if (msg.view === "youtube") e.playback = msg.props;
      this.armIdleRevert(e);
      this.displayObserver?.(wall, msg.view, msg.props);
      this.syncNowPlayingBadge(e);
    } else if (msg.type === "widgets") {
      e.widgets = msg.widgets;
    }
    const payload = JSON.stringify(msg);
    for (const c of e.clients) {
      if (c.readyState === c.OPEN) c.send(payload);
    }
  }

  /** Every viewscreen at once: red alerts, alarm fires, voice state, the
      working indicator. Display-type messages update every entry's state so
      per-wall screen_state stays truthful. */
  broadcastAll(msg: ServerMessage) {
    for (const e of this.displays.values()) {
      this.broadcast(msg, e.name);
    }
  }

  /** TNGC-26: swap a wall's background track WITHOUT touching its visible
      panel — queue advance while a diagram/weather/etc. has that screen. */
  playbackTrack(props: PanelProps, wall: string) {
    const e = this.entry(wall);
    e.playback = props;
    this.broadcast({ type: "playback", action: "track", props }, wall);
    this.syncNowPlayingBadge(e);
  }

  /** End a wall's playback session (media stop, queue exhausted, error). */
  clearPlayback(wall: string) {
    const e = this.entry(wall);
    if (!e.playback) return;
    e.playback = null;
    this.broadcast({ type: "playback", action: "stop" }, wall);
    this.syncNowPlayingBadge(e);
  }

  playbackVideoId(wall: string): string | undefined {
    const v = this.displays.get(wall)?.playback?.videoId;
    return typeof v === "string" ? v : undefined;
  }

  /** The raw props of the playing track (for the audio-fallback flip). */
  playbackProps(wall: string): PanelProps | null {
    return this.displays.get(wall)?.playback ?? null;
  }

  playbackBackgrounded(wall: string): boolean {
    const e = this.displays.get(wall);
    return !!e && e.playback !== null && e.view !== "youtube";
  }

  playbackState(wall: string) {
    const p = this.displays.get(wall)?.playback;
    if (!p) return null;
    return {
      videoId: String(p.videoId ?? ""),
      title: typeof p.title === "string" ? p.title : undefined,
      audioOnly: p.audioOnly === true,
      backgrounded: this.playbackBackgrounded(wall),
    };
  }

  private syncNowPlayingBadge(e: DisplayEntry) {
    const backgrounded = e.playback !== null && e.view !== "youtube";
    const wanted = backgrounded
      ? [{
          id: "nowplaying",
          kind: "nowplaying" as const,
          title:
            (typeof e.playback?.title === "string" && e.playback.title) ||
            String(e.playback?.videoId ?? "playing"),
        }]
      : [];
    // Skip the no-op sync (most panel changes) to avoid widget churn.
    const have = e.widgetSources.get("nowplaying") ?? [];
    if (wanted.length === have.length && (wanted.length === 0 || wanted[0].title === (have[0] as { title?: string }).title)) return;
    this.setWidgets("nowplaying", wanted, e.name);
  }

  /** TNGC-27: set + broadcast the voice setting (persistence is the console
      route's job). One voice — every wall hears the same setting. */
  setVoice(volume: number, muted: boolean) {
    this.voiceVolume = Math.max(0, Math.min(100, Math.round(volume)));
    this.voiceMuted = muted;
    this.broadcastAll({ type: "voice_state", volume: this.voiceVolume, muted: this.voiceMuted });
  }

  get voice() {
    return { volume: this.voiceVolume, muted: this.voiceMuted };
  }

  /**
   * (Re)start a display's fallback-to-status countdown. Any screen change
   * resets it; exempt views cancel it outright.
   */
  private armIdleRevert(e: DisplayEntry) {
    if (e.idleTimer) clearTimeout(e.idleTimer);
    e.idleTimer = undefined;
    if (IDLE_EXEMPT_VIEWS.includes(e.view)) return;
    e.idleTimer = setTimeout(() => {
      e.idleTimer = undefined;
      this.broadcast({ type: "display", view: "status", props: {} }, e.name);
    }, IDLE_REVERT_MS);
  }

  /** Resolves when a display reports the utterance finished, or on timeout.
      With a broadcast utterance (alarms) the first wall to finish resolves —
      the others' reports are no-ops. */
  waitForSpeakDone(utteranceId: string, timeoutMs = 60_000): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.speakWaiters.delete(utteranceId);
        resolve();
      }, timeoutMs);
      this.speakWaiters.set(utteranceId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** One viewscreen's reportable state. */
  stateFor(wall: string) {
    const e = this.entry(wall);
    return {
      view: e.view,
      props: e.props,
      wall: e.name,
      displays: this.roster(),
      connectedDisplays: this.totalClients,
      widgets: e.widgets,
    };
  }
}
