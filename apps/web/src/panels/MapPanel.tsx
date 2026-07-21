import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { MapControlAction, MapPanelProps } from "@tng/shared";

/**
 * LCARS map: CARTO dark basemap tiles pushed into amber by a CSS filter on
 * the tile pane only (see lcars.css) — markers, labels, and attribution stay
 * unfiltered. Same Leaflet+CARTO stack as the powerparcels prototype, tinted
 * for the wall.
 *
 * Voice control: "tng-map-control" window events (zoom_in/out, n/s/e/w)
 * animate the live map in place. After each movement the new view is
 * announced via "tng-map-view" so useSocket can keep the server's
 * screen-state truthful — relative commands then always compose correctly.
 */
export function MapPanel({ lat, lng, zoom = 5, title, markers }: MapPanelProps) {
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  // Headline is state, not just the prop: a voice "goto" retitles it in
  // place ("Boston" → "Damascus") without a re-display.
  const [shownTitle, setShownTitle] = useState(title);
  const titleRef = useRef(title);
  useEffect(() => {
    setShownTitle(title);
    titleRef.current = title;
  }, [title]);

  // Recreate the map only when the REQUESTED view changes (a new display) —
  // voice nudges animate the existing instance instead.
  const viewKey = JSON.stringify([lat, lng, zoom, markers]);

  useEffect(() => {
    const div = divRef.current;
    if (!div || typeof lat !== "number" || typeof lng !== "number") return;

    const map = L.map(div, {
      zoomControl: false, // wall has no pointer; cursor is hidden
      keyboard: false,
      attributionControl: true,
    });
    mapRef.current = map;
    map.attributionControl.setPrefix(false);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      attribution: "© OpenStreetMap · © CARTO",
      subdomains: "abcd",
      maxZoom: 19,
    }).addTo(map);
    map.setView([lat, lng], Math.min(Math.max(zoom, 0), 18));

    for (const m of markers ?? []) {
      if (typeof m?.lat !== "number" || typeof m?.lng !== "number") continue;
      const ring = L.circleMarker([m.lat, m.lng], {
        radius: 10,
        color: "#ff9900",
        weight: 3,
        fillColor: "#ffcc99",
        fillOpacity: 0.35,
      }).addTo(map);
      if (m.label) {
        ring.bindTooltip(m.label, {
          permanent: true,
          direction: "top",
          offset: [0, -12],
          className: "map-label",
        });
      }
    }

    map.on("moveend zoomend", () => {
      const c = map.getCenter();
      window.dispatchEvent(
        new CustomEvent("tng-map-view", {
          detail: { lat: c.lat, lng: c.lng, zoom: map.getZoom(), title: titleRef.current },
        }),
      );
    });

    return () => {
      mapRef.current = null;
      map.remove();
    };
  }, [viewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onControl = (e: Event) => {
      const map = mapRef.current;
      if (!map) return;
      const { action, amount, lat, lng, zoom, title } = ((e as CustomEvent).detail ?? {}) as {
        action?: MapControlAction;
        amount?: number;
        lat?: number;
        lng?: number;
        zoom?: number;
        title?: string;
      };
      const n = typeof amount === "number" && amount > 0 ? Math.min(amount, 6) : 1;
      if (action === "goto" && typeof lat === "number" && typeof lng === "number") {
        if (title) {
          titleRef.current = title;
          setShownTitle(title);
        }
        const targetZoom =
          typeof zoom === "number" ? Math.min(Math.max(zoom, 0), 18) : map.getZoom();
        map.flyTo([lat, lng], targetZoom); // cinematic arc: out, glide, in
      } else if (action === "zoom_in") map.zoomIn(n);
      else if (action === "zoom_out") map.zoomOut(n);
      else if (action) {
        const dir: Record<string, [number, number]> = {
          north: [0, -1],
          south: [0, 1],
          west: [-1, 0],
          east: [1, 0],
        };
        const d = dir[action];
        if (d) {
          const size = map.getSize();
          // One "amount" ≈ half the viewport — a natural voice-command step.
          map.panBy([d[0] * size.x * 0.5 * n, d[1] * size.y * 0.5 * n]);
        }
      }
    };
    window.addEventListener("tng-map-control", onControl);
    return () => window.removeEventListener("tng-map-control", onControl);
  }, []);

  return (
    <div className="map-panel">
      {shownTitle && <div className="map-title">{shownTitle}</div>}
      <div ref={divRef} className="map-frame" />
    </div>
  );
}
