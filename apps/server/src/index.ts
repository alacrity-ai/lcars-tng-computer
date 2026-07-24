import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_SERVER_PORT, WS_PATH } from "@tng/shared";
import { DisplayHub } from "./hub.js";
import { registerConsoleRoutes } from "./routes/console.js";
import { registerArticleRoutes } from "./routes/article.js";
import { registerYoutubeRoutes } from "./routes/youtube.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerQuoteRoutes } from "./routes/quote.js";
import { warmSynthCache } from "./tts.js";

const port = Number(process.env.TNG_SERVER_PORT ?? DEFAULT_SERVER_PORT);
// Loopback by default; the stack container sets TNG_SERVER_HOST=0.0.0.0 so
// Docker can publish the port (host loopback) and the session container can
// reach it by service DNS. Never bind 0.0.0.0 on a bare host — the console
// API is unauthenticated by design.
const host = process.env.TNG_SERVER_HOST ?? "127.0.0.1";

const app = Fastify({ logger: { level: "info" } });
const hub = new DisplayHub();

await app.register(websocket);

app.get("/health", async () => ({
  ok: true,
  mode: process.env.TNG_MODE ?? "dev",
  primary: hub.primary,
  ...hub.stateFor(hub.primary),
}));

app.register(async (scope) => {
  scope.get(WS_PATH, { websocket: true }, (socket) => {
    hub.add(socket);
  });
});

registerConsoleRoutes(app, hub);
registerArticleRoutes(app, hub);
registerYoutubeRoutes(app, hub);
registerProfileRoutes(app, hub);
registerQuoteRoutes(app, hub);

// Appliance mode (TNGC-30): serve the BUILT wall from this same origin, so
// the kiosk needs exactly one port and /api, /ws, /audio are natively
// same-origin — no vite, no proxy. Dev is untouched (env unset → no route).
// Explicit routes above always win over this wildcard (radix-tree routing).
const wallDist = process.env.TNG_WALL_DIST;
if (wallDist) {
  const root = path.resolve(wallDist);
  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
    ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".json": "application/json",
    ".webmanifest": "application/manifest+json", ".map": "application/json",
  };
  app.get("/*", async (req, reply) => {
    const clean = path.normalize(decodeURIComponent(req.url.split("?")[0]));
    let file = path.join(root, clean);
    if (!file.startsWith(root)) return reply.code(403).send({ error: "forbidden" });
    let info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) {
      file = path.join(root, "index.html"); // SPA fallback
      info = await stat(file).catch(() => null);
      if (!info) return reply.code(404).send({ error: "wall build missing" });
    }
    const ext = path.extname(file).toLowerCase();
    // Hashed assets are immutable; everything else revalidates so image
    // updates show up on the next kiosk refresh.
    reply.header(
      "cache-control",
      clean.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    );
    return reply.type(MIME[ext] ?? "application/octet-stream").send(createReadStream(file));
  });
  app.log.info(`serving wall from ${root}`);
}

await app.listen({ port, host });
app.log.info(`TNG Computer server on http://${host}:${port}`);

// Pre-synthesize stock acknowledgments so first responses are instant.
void warmSynthCache();
