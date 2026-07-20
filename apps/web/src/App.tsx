import { LcarsFrame } from "./components/LcarsFrame";
import { BootPanel } from "./panels/BootPanel";

// Phase 0: static shell. Phase 1 replaces the hardcoded panel with the
// WebSocket-driven panel registry.
export function App() {
  return (
    <LcarsFrame title="LCARS 40274">
      <BootPanel />
    </LcarsFrame>
  );
}
