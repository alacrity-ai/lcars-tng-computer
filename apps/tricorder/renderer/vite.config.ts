import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The viewscreen stage (TNGC-37): bundles the canonical wall renderer
 * (@tng/panel-renderer) into a static page the Worker serves at /vs/. The
 * PWA iframes it in Viewscreen mode and feeds it ServerMessages over
 * postMessage — the phone renders panels with the wall's own components.
 *
 * Built into public/vs/ (gitignored build artifact): run
 * `pnpm -C apps/tricorder build:vs` before `wrangler deploy`.
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/vs/",
  plugins: [react()],
  build: {
    outDir: "../public/vs",
    emptyOutDir: true,
  },
});
