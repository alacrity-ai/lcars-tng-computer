import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// /api and /ws proxy to the TNG server so the webapp only ever talks same-origin.
// host: true binds 0.0.0.0 so LAN displays (the TV-room kiosk) can reach the
// wall; the TNG server itself stays loopback-only — remote displays ride this
// proxy, and only :5173 is ever exposed (see docs/sops/tv-room-kiosk.md).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // Vite allows IP-address hosts out of the box; only hostnames need
    // whitelisting (e.g. TNG_ALLOWED_HOSTS=office-pc.local).
    allowedHosts: process.env.TNG_ALLOWED_HOSTS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    proxy: {
      "/api": "http://127.0.0.1:3789",
      "/audio": "http://127.0.0.1:3789",
      "/ws": { target: "ws://127.0.0.1:3789", ws: true },
    },
  },
});
