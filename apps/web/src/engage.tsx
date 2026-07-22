import { useEffect, useState } from "react";

/** 16 samples of 8kHz silence — just enough to probe the autoplay policy. */
const SILENCE =
  "data:audio/wav;base64,UklGRjQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YRAAAACAgICAgICAgICAgICAgICA";

/**
 * Kiosk audio unlock. The local kiosk launches Chrome with
 * --autoplay-policy=no-user-gesture-required, but a plain browser on the TV
 * PC has no such flag — until someone interacts with the page, every TTS line
 * and chime is silently blocked. Probing with a silent clip on mount tells us
 * which world we're in; when blocked, the wall shows a single ENGAGE tap
 * target (the one gesture Chrome needs to allow audio for the rest of the
 * page's life).
 */
export function useEngage(): { needsEngage: boolean; engage: () => void } {
  const [needsEngage, setNeedsEngage] = useState(false);
  useEffect(() => {
    new Audio(SILENCE).play().catch((err: unknown) => {
      if (err instanceof Error && err.name === "NotAllowedError") setNeedsEngage(true);
    });
  }, []);
  const engage = () => {
    void new Audio(SILENCE).play().catch(() => {});
    setNeedsEngage(false);
  };
  return { needsEngage, engage };
}

/** Full-screen tap target; self-contained styling so it needs no CSS file. */
export function EngageOverlay({ onEngage }: { onEngage: () => void }) {
  useEffect(() => {
    const onKey = () => onEngage();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEngage]);

  return (
    <div
      onPointerDown={onEngage}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1.2rem",
        background: "rgba(0, 0, 0, 0.92)",
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <div
        style={{
          padding: "0.9rem 4rem",
          borderRadius: "999px",
          background: "#FF9900",
          color: "#000",
          fontSize: "2.4rem",
          letterSpacing: "0.35em",
          textIndent: "0.35em",
          fontWeight: 700,
        }}
      >
        ENGAGE
      </div>
      <div style={{ color: "#9999CC", fontSize: "0.95rem", letterSpacing: "0.25em" }}>
        TAP ONCE TO ENABLE AUDIO
      </div>
    </div>
  );
}
