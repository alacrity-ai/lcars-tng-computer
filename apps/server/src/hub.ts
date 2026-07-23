import type { WebSocket } from "@fastify/websocket";
import type {
  ClientMessage,
  PanelProps,
  PanelView,
  ServerMessage,
  Widget,
} from "@tng/shared";

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

/**
 * Tracks connected display clients and the current screen state.
 * The server is the source of truth for "what is on screen" so Claude's
 * screen_state tool answers without a webapp round trip.
 */
export class DisplayHub {
  private clients = new Set<WebSocket>();
  private view: PanelView = "boot";
  private props: PanelProps = {};
  /** Overlay widgets (timers, alarms, queue) — panel-independent screen
      state, composed from per-producer lists (see setWidgets). */
  private widgets: Widget[] = [];
  private widgetSources = new Map<string, Widget[]>();
  private speakWaiters = new Map<string, () => void>();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private videoErrorHandler: ((videoId: string, code?: number) => void) | undefined;
  private videoEndedHandler: ((videoId: string) => void) | undefined;
  private displayObserver: ((view: PanelView, props: PanelProps) => void) | undefined;

  /** Called on every display broadcast — the panel history records through
      this tap (see PanelHistory), keeping the hub free of history concerns. */
  setDisplayObserver(handler: (view: PanelView, props: PanelProps) => void) {
    this.displayObserver = handler;
  }

  /** Called when a display reports its video player errored (see
      VideoErrorMessage) — the youtube routes use this to auto-advance. */
  setVideoErrorHandler(handler: (videoId: string, code?: number) => void) {
    this.videoErrorHandler = handler;
  }

  /** Called when a display reports its video finished naturally — the
      youtube routes use this to start the next queued video. */
  setVideoEndedHandler(handler: (videoId: string) => void) {
    this.videoEndedHandler = handler;
  }

  add(socket: WebSocket) {
    this.clients.add(socket);
    socket.on("close", () => this.clients.delete(socket));
    socket.on("message", (raw: Buffer) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.onClientMessage(msg);
    });
    // late joiner gets the current screen immediately
    this.send(socket, { type: "display", view: this.view, props: this.props });
    if (this.widgets.length > 0) {
      this.send(socket, { type: "widgets", widgets: this.widgets });
    }
  }

  private send(socket: WebSocket, msg: ServerMessage) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }

  private onClientMessage(msg: ClientMessage) {
    if (msg.type === "screen_state") {
      this.view = msg.view;
      this.props = msg.props;
      this.armIdleRevert();
    } else if (msg.type === "speak_done") {
      this.speakWaiters.get(msg.utteranceId)?.();
      this.speakWaiters.delete(msg.utteranceId);
    } else if (msg.type === "video_error") {
      this.videoErrorHandler?.(msg.videoId, msg.code);
    } else if (msg.type === "video_ended") {
      this.videoEndedHandler?.(msg.videoId);
    }
  }

  /** Replace one producer's widgets and broadcast the composed list.
      WidgetsMessage is a full-state sync, so producers (TimerEngine, the
      play queue) must not broadcast their own lists — they'd clobber each
      other's. Badge stack order is fixed per producer, not insertion order. */
  setWidgets(source: "commands" | "timers" | "queue", widgets: Widget[]) {
    if (widgets.length === 0) this.widgetSources.delete(source);
    else this.widgetSources.set(source, widgets);
    const composed = (["commands", "timers", "queue"] as const).flatMap(
      (s) => this.widgetSources.get(s) ?? [],
    );
    this.broadcast({ type: "widgets", widgets: composed });
  }

  broadcast(msg: ServerMessage) {
    if (msg.type === "display") {
      this.view = msg.view;
      this.props = msg.props;
      this.armIdleRevert();
      this.displayObserver?.(msg.view, msg.props);
    } else if (msg.type === "widgets") {
      this.widgets = msg.widgets;
    }
    const payload = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.readyState === c.OPEN) c.send(payload);
    }
  }

  /**
   * (Re)start the fallback-to-status countdown. Any screen change resets it;
   * exempt views cancel it outright.
   */
  private armIdleRevert() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (IDLE_EXEMPT_VIEWS.includes(this.view)) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.broadcast({ type: "display", view: "status", props: {} });
    }, IDLE_REVERT_MS);
  }

  /** Resolves when a display reports the utterance finished, or on timeout. */
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

  get state() {
    return {
      view: this.view,
      props: this.props,
      connectedDisplays: this.clients.size,
      widgets: this.widgets,
    };
  }
}
