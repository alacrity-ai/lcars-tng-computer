// Minimal service worker: exists so the PWA is installable. No caching — the
// app is one small page and stale auth UI is worse than a network round-trip.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
