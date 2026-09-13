/**
 * Local development entry: `npm run dev`.
 * Runs the exact same app as production, but owns a long-lived HTTP server —
 * which serverless platforms must never do (hence the separate file).
 */
import createApp from "./app.js";
import { config } from "./config/env.js";
import { ensureDbReady } from "./db/init.js";
import { logger } from "./utils/logger.js";
import { closeClient } from "./db/client.js";

async function main(): Promise<void> {
  await ensureDbReady();
  const app = createApp();

  const server = app.listen(config.port, "0.0.0.0", () => {
    logger.info("server: listening (dev)", {
      port: config.port,
      origins: config.frontendOrigins,
      env: config.nodeEnv,
    });
  });

  const shutdown = (signal: string) => {
    logger.info("server: shutting down", { signal });
    server.close(() => {
      closeClient();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("server: failed to start", { err: String(err) });
  process.exit(1);
});
