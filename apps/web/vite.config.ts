import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api and /ws proxy to the TNG server so the webapp only ever talks same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3789",
      "/ws": { target: "ws://127.0.0.1:3789", ws: true },
    },
  },
});
