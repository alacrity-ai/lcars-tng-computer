import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../motion";

const COLORS = ["cascade-gold", "cascade-peach", "cascade-lavender", "cascade-blue"];

interface Cell {
  value: string;
  color: string;
}

function makeCell(): Cell {
  return {
    value: Math.floor(Math.random() * 10000).toString().padStart(4, "0"),
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  };
}

/** Okudagram data cascade: a calm grid of register readouts where a fraction
    of cells shift value/color each beat. Purely decorative. */
export function DataCascade({ columns = 6, rows = 4 }: { columns?: number; rows?: number }) {
  const [grid, setGrid] = useState<Cell[][]>(() =>
    Array.from({ length: rows }, () => Array.from({ length: columns }, makeCell)),
  );

  useEffect(() => {
    if (prefersReducedMotion()) return;
    const t = window.setInterval(() => {
      if (document.hidden) return;
      setGrid((g) => g.map((row) => row.map((cell) => (Math.random() < 0.15 ? makeCell() : cell))));
    }, 450);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="data-cascade" aria-hidden>
      {grid.map((row, r) => (
        <div key={r} className="cascade-row">
          {row.map((cell, c) => (
            <span key={c} className={`cascade-cell ${cell.color}`}>
              {cell.value}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
