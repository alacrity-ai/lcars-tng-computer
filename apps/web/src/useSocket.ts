import { useEffect, useRef, useState } from "react";
import type {
  ClientMessage,
  PanelProps,
  PanelView,
  ServerMessage,
} from "@tng/shared";
import { playChime } from "./audio";

export interface ScreenState {
  view: PanelView;
  props: PanelProps;
}

export interface VoiceLine {
  utteranceId: string;
  text: string;
}

/** Estimated caption dwell time while TTS is offline (Phase 2 replaces with real audio). */
function captionMs(text: string): number {
  return Math.min(8000, Math.max(1200, 250 + text.length * 55));
}

export function useSocket() {
  const [screen, setScreen] = useState<ScreenState>({ view: "boot", props: {} });
  const [voice, setVoice] = useState<VoiceLine | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let retry = 0;

    function connect() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      const send = (msg: ClientMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      };

      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        send({ type: "hello", role: "display" });
      };

      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "display") {
          setScreen({ view: msg.view, props: msg.props });
          send({ type: "screen_state", view: msg.view, props: msg.props });
        } else if (msg.type === "chime") {
          void playChime(msg.name);
        } else if (msg.type === "speak") {
          const { utteranceId, text, audioUrl } = msg;
          setVoice({ utteranceId, text });
          if (audioUrl) {
            const audio = new Audio(audioUrl);
            const done = () => {
              setVoice((v) => (v?.utteranceId === utteranceId ? null : v));
              send({ type: "speak_done", utteranceId });
            };
            audio.onended = done;
            audio.onerror = done;
            void audio.play().catch(done);
          } else {
            // TTS offline: caption only, report done after a reading-time estimate
            setTimeout(() => {
              setVoice((v) => (v?.utteranceId === utteranceId ? null : v));
              send({ type: "speak_done", utteranceId });
            }, captionMs(text));
          }
        }
      };

      ws.onclose = () => {
        setConnected(false);
        if (!disposed) setTimeout(connect, Math.min(5000, 500 * 2 ** retry++));
      };
    }

    connect();
    return () => {
      disposed = true;
      wsRef.current?.close();
    };
  }, []);

  return { screen, voice, connected };
}
