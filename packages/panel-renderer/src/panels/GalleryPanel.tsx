import { useEffect, useMemo, useRef, useState } from "react";
import type { GalleryPanelProps, GalleryPhoto } from "@tng/shared";

/** Ambient photo memories (TNGC-64). Two stacked <img> layers crossfade on a
    timer; the next image is preloaded into the hidden layer before the swap
    so the wall never flashes a loading frame. Deliberately quiet chrome — in
    idle-takeover use this IS the room's picture frame. */
const DEFAULT_INTERVAL_MS = 8_000;
const MONTH_NAMES = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

function caption(photo: GalleryPhoto): string {
  const parts: string[] = [];
  if (photo.takenAt) {
    const d = new Date(photo.takenAt);
    parts.push(`${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`);
  }
  if (photo.album) parts.push(photo.album.toUpperCase());
  return parts.join(" · ");
}

/** Deterministic-enough shuffle: sort by a hash of the url so the order is
    stable per photo set (re-renders don't reshuffle mid-show). */
function shuffled(photos: GalleryPhoto[]): GalleryPhoto[] {
  const hash = (s: string) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 16777619) >>> 0;
    return h;
  };
  return [...photos].sort((a, b) => hash(a.url) - hash(b.url));
}

export function GalleryPanel({ photos, title, intervalMs, shuffle, fullscreen }: GalleryPanelProps) {
  const ordered = useMemo(
    () => (shuffle === false ? photos : shuffled(photos)),
    [photos, shuffle],
  );
  const [index, setIndex] = useState(0);
  // "Full screen" / "exit full screen" mid-show (TNGC-68): same tng-media
  // fullscreen/windowed events the video playback layer follows, so the
  // slideshow expands in place — no re-display, no restart at photo 1.
  const [full, setFull] = useState(fullscreen === true);
  useEffect(() => {
    function onMedia(ev: Event) {
      const { action } = (ev as CustomEvent<{ action: string }>).detail ?? {};
      if (action === "fullscreen" || action === "windowed") setFull(action === "fullscreen");
    }
    window.addEventListener("tng-media", onMedia);
    return () => window.removeEventListener("tng-media", onMedia);
  }, []);
  const period = Math.max(3_000, intervalMs ?? DEFAULT_INTERVAL_MS);
  const count = ordered.length;
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setIndex(0);
    if (count < 2) return;
    timer.current = setInterval(() => setIndex((i) => (i + 1) % count), period);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [count, period, ordered]);

  const cls = full ? "gal-panel gal-full" : "gal-panel";

  if (!count) {
    return (
      <div className={cls}>
        <div className="gal-empty">
          NO PHOTOS YET
          <span>Upload some from the tricorder&rsquo;s Photos plugin.</span>
        </div>
      </div>
    );
  }

  const current = ordered[index];
  const next = ordered[(index + 1) % count];

  return (
    <div className={cls}>
      {/* two layers: only the current is visible; the next preloads beneath */}
      <img key={current.url} className="gal-img show" src={current.url} alt="" />
      {count > 1 ? <img key={`pre-${next.url}`} className="gal-img" src={next.url} alt="" /> : null}
      <div className="gal-chrome">
        <span className="gal-title">{title ?? "MEMORIES"}</span>
        <span className="gal-caption">{caption(current)}</span>
        <span className="gal-pos">
          {index + 1} / {count}
        </span>
      </div>
    </div>
  );
}
