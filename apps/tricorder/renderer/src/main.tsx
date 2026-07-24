import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import type { PanelProps, PanelView, Widget } from "@tng/shared";
import { LcarsFrame, Panel, WidgetLayer } from "@tng/panel-renderer";
import "@fontsource/antonio/400.css";
import "@fontsource/antonio/700.css";
import "@tng/panel-renderer/lcars.css";

/**
 * The viewscreen stage (TNGC-37): the wall renderer, hosted for a phone.
 *
 * The PWA iframes this page in Viewscreen mode and forwards ServerMessages
 * verbatim as `{type:"tng-frame", msg}` postMessages. The PWA sizes the
 * iframe ELEMENT at exactly 1280×720 and scales it with a CSS transform, so
 * this document's viewport IS a wall's: lcars.css's vh/vw sizing (the frame
 * itself is height:100vh) resolves identically to the TV, and parity needs
 * no scaling logic in here at all.
 *
 * Deliberately NOT handled here (the PWA keeps these phone-native): youtube
 * playback (IFrame API events must ride the screen socket to advance the
 * queue), speak captions (TTS deferred), chimes, and the working chip —
 * though the working badge also renders on-stage for wall parity.
 */

interface ScreenState {
  view: PanelView;
  props: PanelProps;
}

/** Pinch-zoom for the stage (TNGC-37 follow-up): two fingers zoom in on the
    wall (anchored at the pinch midpoint), two-finger drag pans while zoomed,
    double-tap resets. Touches over a live Leaflet map are left alone — there
    the pinch should zoom the MAP, not the stage. Transform is mutated
    directly (no React re-render per move). */
function useStageZoom(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    let z = 1;
    let tx = 0;
    let ty = 0;
    let pinch: { d0: number; z0: number; tx0: number; ty0: number; mx0: number; my0: number } | null = null;
    let lastTap = 0;
    const apply = () => {
      // cover the viewport: never zoom below 1, never pan past an edge
      z = Math.min(4, Math.max(1, z));
      tx = Math.min(0, Math.max(1280 * (1 - z), tx));
      ty = Math.min(0, Math.max(720 * (1 - z), ty));
      if (ref.current) ref.current.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
    };
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      if (e.target instanceof Element && e.target.closest(".leaflet-container")) return;
      e.preventDefault();
      pinch = {
        d0: dist(e.touches),
        z0: z,
        tx0: tx,
        ty0: ty,
        mx0: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        my0: (e.touches[0].clientY + e.touches[1].clientY) / 2,
      };
    };
    const onMove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const d = dist(e.touches);
      const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const my = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      z = pinch.z0 * (d / pinch.d0);
      z = Math.min(4, Math.max(1, z));
      // keep the content under the fingers under the fingers, plus pan
      const k = z / pinch.z0;
      tx = mx - k * (pinch.mx0 - pinch.tx0);
      ty = my - k * (pinch.my0 - pinch.ty0);
      apply();
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch = null;
      // double-tap (while zoomed) snaps back to the full wall
      if (e.touches.length === 0 && e.changedTouches.length === 1 && z > 1.01) {
        const now = Date.now();
        if (now - lastTap < 300) {
          z = 1;
          tx = 0;
          ty = 0;
          lastTap = 0;
          apply();
        } else {
          lastTap = now;
        }
      }
    };
    document.addEventListener("touchstart", onStart, { passive: false });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, [ref]);
}

function Stage() {
  const [screen, setScreen] = useState<ScreenState>({ view: "boot", props: {} });
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [working, setWorking] = useState(false);
  const workingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const zoomRef = useRef<HTMLDivElement | null>(null);
  useStageZoom(zoomRef);

  useEffect(() => {
    const clearWorking = () => {
      if (workingTimer.current) clearTimeout(workingTimer.current);
      workingTimer.current = null;
      setWorking(false);
    };
    const onMessage = (e: MessageEvent) => {
      // Same-origin iframe: only the embedding PWA may drive the stage.
      if (e.origin !== location.origin || e.source !== window.parent) return;
      const data = e.data as { type?: string; msg?: Record<string, unknown> } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === "tng-reset") {
        clearWorking();
        setScreen({ view: "boot", props: {} });
        setWidgets([]);
        return;
      }
      if (data.type !== "tng-frame" || !data.msg || typeof data.msg !== "object") return;
      const msg = data.msg;
      switch (msg.type) {
        case "display":
          // Content landing is the request being fulfilled — same rule as the
          // wall's useSocket.
          clearWorking();
          setScreen({ view: msg.view as PanelView, props: (msg.props as PanelProps) ?? {} });
          break;
        case "widgets":
          setWidgets(Array.isArray(msg.widgets) ? (msg.widgets as Widget[]) : []);
          break;
        case "working":
          if (msg.active) {
            if (workingTimer.current) clearTimeout(workingTimer.current);
            setWorking(true);
            // Backstop only — working:false at turn end is the real signal.
            workingTimer.current = setTimeout(() => setWorking(false), 300_000);
          } else {
            clearWorking();
          }
          break;
        // Live panels (map, night-sky, media consumers) listen on window
        // events — same loose coupling as the wall's useSocket.
        case "media":
          window.dispatchEvent(
            new CustomEvent("tng-media", {
              detail: { action: msg.action, rate: msg.rate, level: msg.level },
            }),
          );
          break;
        case "map_control":
          window.dispatchEvent(
            new CustomEvent("tng-map-control", {
              detail: {
                action: msg.action,
                amount: msg.amount,
                lat: msg.lat,
                lng: msg.lng,
                zoom: msg.zoom,
                title: msg.title,
              },
            }),
          );
          break;
        case "sky_control": {
          const { type: _type, ...detail } = msg;
          window.dispatchEvent(new CustomEvent("tng-sky-control", { detail }));
          break;
        }
        default:
          // speak / playback / chime / voice_state stay phone-native.
          break;
      }
    };
    window.addEventListener("message", onMessage);
    // Tell the PWA the stage is live — it flushes any queued frames.
    window.parent.postMessage({ type: "tng-vs-ready" }, location.origin);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div
      ref={zoomRef}
      style={{ width: "100%", height: "100%", transformOrigin: "0 0", willChange: "transform" }}
    >
      <LcarsFrame title="LCARS 40274">
        <div key={screen.view} className="panel-wipe">
          <Panel
            view={screen.view}
            props={screen.view === "status" ? { ...screen.props, working } : screen.props}
          />
        </div>
        <WidgetLayer widgets={widgets} />
        {working && (
          <div className="working-badge">
            <span className="working-sweep" aria-hidden>
              <i /><i /><i /><i />
            </span>
            Processing
          </div>
        )}
      </LcarsFrame>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Stage />
  </React.StrictMode>,
);
