import type { WebSocket } from "@fastify/websocket";
import type {
  ClientMessage,
  PanelProps,
  PanelView,
  ServerMessage,
} from "@tng/shared";

/**
 * Tracks connected display clients and the current screen state.
 * The server is the source of truth for "what is on screen" so Claude's
 * screen_state tool answers without a webapp round trip.
 */
export class DisplayHub {
  private clients = new Set<WebSocket>();
  private view: PanelView = "boot";
  private props: PanelProps = {};
  private speakWaiters = new Map<string, () => void>();

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
  }

  private send(socket: WebSocket, msg: ServerMessage) {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }

  private onClientMessage(msg: ClientMessage) {
    if (msg.type === "screen_state") {
      this.view = msg.view;
      this.props = msg.props;
    } else if (msg.type === "speak_done") {
      this.speakWaiters.get(msg.utteranceId)?.();
      this.speakWaiters.delete(msg.utteranceId);
    }
  }

  broadcast(msg: ServerMessage) {
    if (msg.type === "display") {
      this.view = msg.view;
      this.props = msg.props;
    }
    const payload = JSON.stringify(msg);
    for (const c of this.clients) {
      if (c.readyState === c.OPEN) c.send(payload);
    }
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
    };
  }
}
