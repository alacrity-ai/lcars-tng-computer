import { LcarsFrame } from "./components/LcarsFrame";
import { Panel } from "./panels/registry";
import { useSocket } from "./useSocket";

export function App() {
  const { screen, voice, connected } = useSocket();

  return (
    <LcarsFrame title="LCARS 40274">
      {/* keyed by view so switching panels re-runs the wipe-in */}
      <div key={screen.view} className="panel-wipe">
        <Panel view={screen.view} props={screen.props} />
      </div>
      {voice && (
        <div className="voice-caption">
          <span className="voice-bars" aria-hidden>
            <i /><i /><i /><i /><i />
          </span>
          {voice.text}
        </div>
      )}
      {!connected && <div className="offline-badge">Link offline</div>}
    </LcarsFrame>
  );
}
