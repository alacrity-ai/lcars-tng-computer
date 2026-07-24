import type { WeatherDay, WeatherPanelProps } from "@tng/shared";

/** Column accent colors, cycled — LCARS blocks are never all one hue. */
const ACCENTS = ["bg-gold", "bg-lavender", "bg-blue", "bg-peach", "bg-cream"];

function DayColumn({ day, accent }: { day: WeatherDay; accent: string }) {
  const precip = typeof day.precip === "number" ? Math.max(0, Math.min(100, day.precip)) : undefined;
  return (
    <div className="weather-day">
      <div className={`weather-day-cap ${accent}`}>{day.name}</div>
      <div className="weather-temps">
        <span className="weather-high">{Math.round(day.high)}</span>
        {typeof day.low === "number" && (
          <span className="weather-low">{Math.round(day.low)}</span>
        )}
      </div>
      <div className="weather-conditions">{day.conditions}</div>
      {precip !== undefined && (
        <div className="weather-precip">
          <div className="weather-precip-track">
            <div
              className={`weather-precip-fill${precip >= 60 ? " wet" : ""}`}
              style={{ width: `${precip}%` }}
            />
          </div>
          <div className="weather-precip-label">{precip}%</div>
        </div>
      )}
    </div>
  );
}

export function WeatherPanel({ location, days, units = "F" }: WeatherPanelProps) {
  const list = Array.isArray(days) ? days : [];

  return (
    <div className="weather-panel">
      <div className="weather-head">
        <div className="weather-location">{location}</div>
        <div className="weather-sub">
          {list.length}-day forecast · degrees {units === "C" ? "celsius" : "fahrenheit"}
        </div>
      </div>
      {list.length === 0 ? (
        <div className="weather-empty">No forecast data</div>
      ) : (
        <div className="weather-grid">
          {list.map((day, i) => (
            <DayColumn key={`${day.name}-${i}`} day={day} accent={ACCENTS[i % ACCENTS.length]} />
          ))}
        </div>
      )}
    </div>
  );
}
