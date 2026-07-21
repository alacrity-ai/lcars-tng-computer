import { useEffect, useRef } from "react";
import type { MediaAction, YouTubePanelProps } from "@tng/shared";

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

  useEffect(() => {
    function onMedia(ev: Event) {
      const action = (ev as CustomEvent<MediaAction>).detail;
      const func = action === "pause" ? "pauseVideo" : "playVideo";
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "command", func, args: [] }),
        "https://www.youtube.com",
      );
    }
    window.addEventListener("tng-media", onMedia);
    return () => window.removeEventListener("tng-media", onMedia);
  }, []);

  // Subscribe to the player's event stream so embed failures (101/150 =
  // embedding disabled, 100 = not found) are reported instead of leaving a
  // dead "Video unavailable" frame — the server swaps in the next result.
  useEffect(() => {
    const subscribe = () =>
      frameRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "listening", id: videoId }),
        "https://www.youtube.com",
      );
    // The player needs a beat to boot before it honors "listening".
    const timer = setInterval(subscribe, 700);
    const stopAfter = setTimeout(() => clearInterval(timer), 5_000);

    let reported = false;
    let endedReported = false;
    const onMessage = (ev: MessageEvent) => {
      if (ev.origin !== "https://www.youtube.com") return;
      let data: { event?: string; info?: unknown };
      try {
        data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data;
      } catch {
        return;
      }
      if (data?.event === "onError" && !reported) {
        reported = true;
        window.dispatchEvent(
          new CustomEvent("tng-video-error", {
            detail: { videoId, code: Number(data.info) || undefined },
          }),
        );
      }
      // Natural end (onStateChange → 0 = ENDED): the server advances the
      // play queue. Once per mount — replays after a seek don't re-fire.
      if (data?.event === "onStateChange" && Number(data.info) === 0 && !endedReported) {
        endedReported = true;
        window.dispatchEvent(new CustomEvent("tng-video-ended", { detail: { videoId } }));
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      clearInterval(timer);
      clearTimeout(stopAfter);
      window.removeEventListener("message", onMessage);
    };
  }, [videoId]);

  const params = new URLSearchParams({ rel: "0", enablejsapi: "1", origin: location.origin });
  if (autoplay) params.set("autoplay", "1");
  if (startSeconds && startSeconds > 0) params.set("start", String(Math.floor(startSeconds)));

  return (
    <div className="youtube-panel">
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
