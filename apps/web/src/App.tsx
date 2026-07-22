import { useEffect, useState } from "react";
import { LcarsFrame } from "./components/LcarsFrame";
import { WidgetLayer } from "./components/WidgetLayer";
import { Panel } from "./panels/registry";
import { useSocket } from "./useSocket";
import { EngageOverlay, useEngage } from "./engage";

/** Tripwire for the stacked-app failure mode (a dev-server re-execution
    mounting a second live copy — two sockets, two karaoke carets, doubled
    text). If it ever happens again, the wall says so instead of just
    looking haunted. */
function useDuplicateInstanceCheck(): boolean {
  const [duplicated, setDuplicated] = useState(false);
  useEffect(() => {
    const check = () => {
      const n = document.querySelectorAll(".lcars-frame").length;
      if (n > 1) {
        console.error(`[tng] ${n} app instances mounted in one page — stale duplicate; hard-refresh`);
        setDuplicated(true);
      }
    };
    check();
    const timer = setInterval(check, 5000);
    return () => clearInterval(timer);
  }, []);
  return duplicated;
}

export function App() {
  const { screen, voice, connected, audioLocked, working, widgets } = useSocket();
  const duplicated = useDuplicateInstanceCheck();
  const { needsEngage, engage } = useEngage();

  return (
    <LcarsFrame title="LCARS 40274">
      {/* keyed by view so switching panels re-runs the wipe-in; the status
          board additionally reflects the working state ("Processing request"
          instead of "Awaiting instruction") */}
      <div key={screen.view} className="panel-wipe">
        <Panel
          view={screen.view}
          props={screen.view === "status" ? { ...screen.props, working } : screen.props}
        />
      </div>
      <WidgetLayer widgets={widgets} />
      {voice && (
        <div className={voice.caption ? "voice-caption" : "voice-caption voice-caption-quiet"}>
          <div className="voice-caption-inner">
            <span className="voice-bars" aria-hidden>
              <i /><i /><i /><i /><i />
            </span>
            {voice.caption && <span className="voice-caption-text">{voice.text}</span>}
          </div>
        </div>
      )}
      {!connected && <div className="offline-badge">Link offline</div>}
      {duplicated && <div className="offline-badge">Duplicate UI instance — hard refresh</div>}
      {audioLocked && !needsEngage && (
        <div className="audio-locked-badge">Audio muted by browser — tap to enable</div>
      )}
      {needsEngage && <EngageOverlay onEngage={engage} />}
      {working && (
        <div className="working-badge">
          <span className="working-sweep" aria-hidden>
            <i /><i /><i /><i />
          </span>
          Processing
        </div>
      )}
    </LcarsFrame>
  );
}
