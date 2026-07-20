import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { prefersReducedMotion } from "../motion";

const SIDEBAR_BLOCKS = [
  { color: "bg-gold" },
  { color: "bg-lavender" },
  { color: "bg-blue", tall: true },
  { color: "bg-red" },
  { color: "bg-gold" },
];

// Boot with the easter-egg dates; ambient ticks replace them with register noise.
const INITIAL_CODES = ["02-262000", "03-111968", "04-041969", "05-1701D", "06-060794"];

function randomCode(i: number): string {
  let digits = "";
  for (let d = 0; d < 6; d++) digits += Math.floor(Math.random() * 10);
  return `0${i + 2}-${digits}`;
}

export function LcarsFrame({ title, children }: { title: string; children: ReactNode }) {
  const [codes, setCodes] = useState(INITIAL_CODES);
  const [flicker, setFlicker] = useState<number | null>(null);

  // Each block's readout re-randomizes on its own irregular clock (2–8 s),
  // deliberately out of lockstep with its neighbors.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const stops = INITIAL_CODES.map((_, i) => {
      let t: number;
      const tick = () => {
        if (!document.hidden) {
          setCodes((c) => c.map((code, j) => (j === i ? randomCode(i) : code)));
        }
        t = window.setTimeout(tick, 2000 + Math.random() * 6000);
      };
      t = window.setTimeout(tick, 2000 + Math.random() * 6000);
      return () => window.clearTimeout(t);
    });
    return () => stops.forEach((stop) => stop());
  }, []);

  // Rare single-block flicker — background processes, one block at a time.
  useEffect(() => {
    if (prefersReducedMotion()) return;
    let t: number;
    let clear: number | undefined;
    const tick = () => {
      if (!document.hidden) {
        setFlicker(Math.floor(Math.random() * SIDEBAR_BLOCKS.length));
        clear = window.setTimeout(() => setFlicker(null), 950);
      }
      t = window.setTimeout(tick, 10000 + Math.random() * 20000);
    };
    t = window.setTimeout(tick, 10000 + Math.random() * 20000);
    return () => {
      window.clearTimeout(t);
      if (clear !== undefined) window.clearTimeout(clear);
    };
  }, []);

  return (
    <div className="lcars-frame">
      <div className="lcars-elbow-top" />
      <header className="lcars-header">
        <div className="bar bg-gold" style={{ flex: 3 }} />
        <div className="title">{title}</div>
        <div className="bar bg-lavender" style={{ flex: 1 }} />
        <div className="bar bg-red" style={{ flex: 0.4 }} />
      </header>

      <nav className="lcars-sidebar">
        {SIDEBAR_BLOCKS.map((b, i) => (
          <div
            key={i}
            className={`block ${b.color} ${b.tall ? "tall" : ""} ${flicker === i ? "flicker" : ""}`}
          >
            <span className="lcars-code">{codes[i]}</span>
          </div>
        ))}
      </nav>

      <main className="lcars-content">{children}</main>

      <div className="lcars-elbow-bottom" />
      <footer className="lcars-footer">
        <div className="bar bg-blue" style={{ flex: 1 }} />
        <div className="bar bg-peach" style={{ flex: 2.5 }} />
        <div className="bar bg-gold" style={{ flex: 0.5 }} />
      </footer>
    </div>
  );
}
