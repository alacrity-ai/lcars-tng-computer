import { useEffect, useState } from "react";
import { normalizeDisplayName } from "@tng/shared";

/**
 * Viewscreen identity (TNGC-35). A physical screen self-labels once:
 * `?display=` beats localStorage beats nothing. With nothing, the wall still
 * connects (the server lands unnamed clients on the primary wall — a one-wall
 * house upgrades with zero behavior change) and the picker is reachable from
 * the corner label, or shows pre-ENGAGE on screens that need the audio tap.
 */
export function resolveInitialDisplay(): string | null {
  const fromUrl = new URLSearchParams(location.search).get("display");
  if (fromUrl) {
    const name = normalizeDisplayName(fromUrl);
    if (name) {
      try {
        localStorage.setItem("tng.display", name);
      } catch {
        // private mode — the URL param still applies for this session
      }
      return name;
    }
  }
  try {
    return localStorage.getItem("tng.display");
  } catch {
    return null;
  }
}

const SUGGESTED = ["living-room", "bedroom", "office", "kitchen", "den"];

interface RosterEntry {
  name: string;
  clients: number;
  primary?: boolean;
}

/**
 * "WHICH VIEWSCREEN IS THIS?" — full-screen picker. Renders pre-ENGAGE on
 * fresh screens (a click is already required there, so the cursor is alive;
 * after ENGAGE it hides exactly as today) and on corner-label taps for
 * re-designation. Choosing also fires onEngage so one tap does both jobs.
 */
export function ViewscreenPicker({
  current,
  onPick,
  onDismiss,
}: {
  current: string | null;
  onPick: (name: string) => void;
  onDismiss: () => void;
}) {
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [custom, setCustom] = useState("");

  useEffect(() => {
    fetch("/api/console/displays")
      .then((r) => r.json())
      .then((d: { displays?: RosterEntry[] }) => setRoster(d.displays ?? []))
      .catch(() => {
        // server unreachable — suggestions alone still work
      });
  }, []);

  const names = [...new Set([...roster.map((r) => r.name), ...SUGGESTED])];
  const pick = (raw: string) => {
    const name = normalizeDisplayName(raw);
    if (name) onPick(name);
  };

  const pill = (bg: string): React.CSSProperties => ({
    padding: "0.55rem 1.6rem",
    borderRadius: "999px",
    background: bg,
    color: "#000",
    border: "none",
    fontSize: "1.05rem",
    letterSpacing: "0.18em",
    textIndent: "0.18em",
    fontWeight: 700,
    textTransform: "uppercase",
    cursor: "pointer",
    fontFamily: "inherit",
  });

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1001,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1.4rem",
        background: "rgba(0, 0, 0, 0.94)",
        userSelect: "none",
      }}
    >
      <div style={{ color: "#FF9900", fontSize: "1.6rem", letterSpacing: "0.3em", textIndent: "0.3em", fontWeight: 700 }}>
        WHICH VIEWSCREEN IS THIS?
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.8rem", justifyContent: "center", maxWidth: "70%" }}>
        {names.map((n) => (
          <button key={n} onClick={() => pick(n)} style={pill(n === current ? "#FFCC99" : "#FF9900")}>
            {n}
          </button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          pick(custom);
        }}
        style={{ display: "flex", gap: "0.7rem", alignItems: "center" }}
      >
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="or name it…"
          autoFocus
          style={{
            background: "#111",
            border: "2px solid #9999CC",
            borderRadius: "999px",
            color: "#fff",
            fontSize: "1.05rem",
            padding: "0.5rem 1.2rem",
            outline: "none",
            fontFamily: "inherit",
            letterSpacing: "0.08em",
          }}
        />
        <button type="submit" style={pill("#CC99CC")}>Set</button>
      </form>
      <button
        onClick={onDismiss}
        style={{ background: "none", border: "none", color: "#9999CC", fontSize: "0.9rem", letterSpacing: "0.25em", cursor: "pointer", fontFamily: "inherit" }}
      >
        {current ? `KEEP “${current.toUpperCase()}”` : "SKIP — PRIMARY WALL"}
      </button>
    </div>
  );
}

/** Subtle bottom-right identity label; tapping it reopens the picker (the
    standard kiosk pattern — the cursor un-hides on mousemove, and touch
    screens never had one). */
export function ViewscreenLabel({ name, primary, onClick }: { name: string; primary: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Tap to re-designate this viewscreen"
      style={{
        position: "fixed",
        right: "0.9rem",
        bottom: "0.6rem",
        zIndex: 40,
        background: "none",
        border: "none",
        color: "#3a3a55",
        fontSize: "0.72rem",
        letterSpacing: "0.28em",
        cursor: "pointer",
        fontFamily: "inherit",
        textTransform: "uppercase",
        padding: "0.3rem 0.4rem",
      }}
    >
      {name}
      {primary ? " ◆" : ""}
    </button>
  );
}
