import type { ReactNode } from "react";

const SIDEBAR_BLOCKS = [
  { color: "bg-gold", code: "02-262000" },
  { color: "bg-lavender", code: "03-111968" },
  { color: "bg-blue", code: "04-041969", tall: true },
  { color: "bg-red", code: "05-1701D" },
  { color: "bg-gold", code: "06-060794" },
];

export function LcarsFrame({ title, children }: { title: string; children: ReactNode }) {
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
        {SIDEBAR_BLOCKS.map((b) => (
          <div key={b.code} className={`block ${b.color} ${b.tall ? "tall" : ""}`}>
            <span className="lcars-code">{b.code}</span>
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
