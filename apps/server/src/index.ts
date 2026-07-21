import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { DEFAULT_SERVER_PORT, WS_PATH } from "@tng/shared";
import { DisplayHub } from "./hub.js";
import { registerConsoleRoutes } from "./routes/console.js";
import { registerArticleRoutes } from "./routes/article.js";
import { registerYoutubeRoutes } from "./routes/youtube.js";
import { registerProfileRoutes } from "./routes/profile.js";
import { registerQuoteRoutes } from "./routes/quote.js";
import { warmSynthCache } from "./tts.js";

const port = Number(process.env.TNG_SERVER_PORT ?? DEFAULT_SERVER_PORT);

const app = Fastify({ logger: { level: "info" } });
const hub = new DisplayHub();

await app.register(websocket);

app.get("/health", async () => ({ ok: true, ...hub.state }));

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

await app.listen({ port, host: "127.0.0.1" });
app.log.info(`TNG Computer server on http://127.0.0.1:${port}`);

// Pre-synthesize stock acknowledgments so first responses are instant.
void warmSynthCache();
