import { useEffect, useRef, useState } from "react";
import type { MediaAction, YouTubePanelProps } from "@tng/shared";
import { videoFullscreen } from "../videoFullscreen";

/**
 * Official YouTube embed — the one "real web" surface that beats reader mode,
 * because video wants actual pixels. youtube.com/embed permits framing (unlike
 * youtube.com proper), and the kiosk's --autoplay-policy flag lets autoplay
 * start with sound.
 *
 * enablejsapi=1 lets us drive playback over postMessage, so "computer, pause"
 * works on a wall with no pointing device (useSocket rebroadcasts media
 * messages as tng-media DOM events).
 */
export function YouTubePanel({ videoId, title, autoplay = true, startSeconds }: YouTubePanelProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // CSS full-bleed, not the browser Fullscreen API — requestFullscreen()
  // needs a user gesture, and the wall has no pointing device. Seeded from
  // module scope so a remount mid-queue keeps the wall full screen.
  const [fullscreen, setFullscreen] = useState(videoFullscreen.value);

  useEffect(() => {
    function onMedia(ev: Event) {
      const { action, rate } = (ev as CustomEvent<{ action: MediaAction; rate?: number }>)
        .detail;
      if (action === "fullscreen" || action === "windowed") {
        setFullscreen(action === "fullscreen");
        return;
      }
      // "stop" pauses rather than resumes (it used to fall through to
      // playVideo); stopVideo would unload the player entirely.
      const command: { func: string; args: unknown[] } =
        action === "play"
          ? { func: "playVideo", args: [] }
          : action === "speed"
            ? { func: "setPlaybackRate", args: [rate ?? 1] }
            : { func: "pauseVideo", args: [] };
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "command", ...command }),
        "https://www.youtube.com",
      );
    }
    window.addEventListener("tng-media", onMedia);
    return () => window.removeEventListener("tng-media", onMedia);
  }, []);

  // Subscribe to the player's event stream so embed failures (101/150 =
  // embedding disabled, 100 = not found) are reported instead of leaving a
  // dead "Video unavailable" frame — the server swaps in the next result —
  // and so natural end advances the play queue.
  useEffect(() => {
    const subscribe = () =>
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: videoId }),
        "https://www.youtube.com",
      );
    // The player honors "listening" only once booted, and playback works fine
    // without the subscription — so a failed handshake is silent and costs us
    // end/error events. Retry until the player's first message proves the
    // stream is live (a slow embed boot outlasts any fixed window).
    let acked = false;
    let timer: number | undefined;
    const startHandshake = () => {
      acked = false;
      if (timer !== undefined) clearInterval(timer);
      timer = window.setInterval(() => {
        if (acked) {
          clearInterval(timer);
          timer = undefined;
        } else {
          subscribe();
        }
      }, 700);
    };
    startHandshake();

    let reported = false;
    let endedReported = false;
    const reportEnded = () => {
      if (endedReported) return;
      endedReported = true;
      window.dispatchEvent(new CustomEvent("tng-video-ended", { detail: { videoId } }));
    };
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== "https://www.youtube.com") return;
      let data: { event?: string; info?: unknown };
      try {
        data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
      } catch {
        return;
      }
      acked = true;
      if (data?.event === "onError" && !reported) {
        reported = true;
        window.dispatchEvent(
          new CustomEvent("tng-video-error", {
            detail: { videoId, code: Number(data.info) || undefined },
          }),
        );
      }
      // Natural end: the server advances the play queue. Once per mount —
      // replays after a seek don't re-fire. Detected two ways, because the
      // discrete ENDED state change is a single message that can be missed:
      // the periodic infoDelivery stream also carries playerState.
      if (data?.event === "onStateChange" && Number(data.info) === 0) reportEnded();
      if (
        data?.event === "infoDelivery" &&
        (data.info as { playerState?: number } | undefined)?.playerState === 0
      ) {
        reportEnded();
      }
    };
    window.addEventListener("message", onMessage);
    // Re-handshake whenever the iframe (re)loads — a reload resets the
    // player's listener list even though our effect never re-ran.
    const frame = frameRef.current;
    const onLoad = () => startHandshake();
    frame?.addEventListener("load", onLoad);
    return () => {
      if (timer !== undefined) clearInterval(timer);
      frame?.removeEventListener("load", onLoad);
      window.removeEventListener("message", onMessage);
    };
  }, [videoId]);

  const params = new URLSearchParams({ rel: "0", enablejsapi: "1", origin: location.origin });
  if (autoplay) params.set("autoplay", "1");
  if (startSeconds && startSeconds > 0) params.set("start", String(Math.floor(startSeconds)));

  return (
    <div className={fullscreen ? "youtube-panel youtube-panel-full" : "youtube-panel"}>
      {title && <div className="youtube-title">{title}</div>}
      <iframe
        ref={frameRef}
        className="youtube-frame"
        src={`https://www.youtube.com/embed/${encodeURIComponent(videoId)}?${params.toString()}`}
        title={title ?? "Video"}
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
      />
    </div>
  );
}
