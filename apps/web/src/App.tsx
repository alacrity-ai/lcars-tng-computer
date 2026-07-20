import { LcarsFrame } from "./components/LcarsFrame";
import { Panel } from "./panels/registry";
import { useSocket } from "./useSocket";

export function App() {
  const { screen, voice, connected } = useSocket();

  return (
    <LcarsFrame title="LCARS 40274">
      <Panel view={screen.view} props={screen.props} />
      {voice && <div className="voice-caption">{voice.text}</div>}
      {!connected && <div className="offline-badge">Link offline</div>}
    </LcarsFrame>
  );
}
