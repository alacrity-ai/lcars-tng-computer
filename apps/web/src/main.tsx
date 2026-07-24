import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/antonio/400.css";
import "@fontsource/antonio/700.css";
import "@tng/panel-renderer/lcars.css";
import { App } from "./App";

declare global {
  interface Window {
    /** Singleton React root — survives dev-server re-executions of this module. */
    __tngRoot?: ReactDOM.Root;
  }
}

const container = document.getElementById("root")!;

// If this module re-executes (vite HMR edge cases), createRoot() again on the
// same container would STACK a second live app — two WebSockets, two audio
// players, two karaoke carets — because React 18 does not clear existing DOM.
// Reuse the one root instead: rendering into it replaces the old tree and
// runs its effect cleanups (closing the old socket).
if (!window.__tngRoot) {
  container.replaceChildren(); // drop any zombie DOM from a dead instance
  window.__tngRoot = ReactDOM.createRoot(container);
}

window.__tngRoot.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
