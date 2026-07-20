import { Fragment, useEffect, useState } from "react";
import type { StatusPanelProps } from "@tng/shared";
import { DataCascade } from "../components/DataCascade";

/** TNG-flavored decorative stardate — continuous, not canon-accurate.
    Two decimals so it visibly ticks (~every 3 s). */
function stardate(d: Date): string {
  const year = d.getFullYear();
  const start = new Date(year, 0, 1).getTime();
  const end = new Date(year + 1, 0, 1).getTime();
  const frac = (d.getTime() - start) / (end - start);
  return ((year - 1987) * 1000 + frac * 1000).toFixed(2);
}

export function StatusPanel({ lines }: StatusPanelProps) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const timeParts = now
    .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    .split(":");

  return (
    <div className="status-panel">
      <div className="status-clock">
        {timeParts.map((part, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="status-colon">:</span>}
            {part}
          </Fragment>
        ))}
      </div>
      <div className="status-date">
        {now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
      </div>
      <div className="status-stardate">Stardate {stardate(now)}</div>
      <div className="status-lines">
        {(lines ?? ["All systems nominal", "Awaiting instruction"]).map((l) => (
          <div key={l} className="status-line">{l}</div>
        ))}
      </div>
      <DataCascade columns={6} rows={4} />
    </div>
  );
}
