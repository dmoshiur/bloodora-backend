/**
 * Local development entry: `npm run dev`.
 *
 * Runs the exact same app as production, but owns a long-lived HTTP server —
 * which serverless platforms must never do (hence the separate file; the
 * production entry is `api/index.ts`, whose handler is exported, never listened).
 *
 * The database bootstrap deliberately does NOT block `listen()`. It used to
 * (`await ensureDbReady()` first), so a Turso outage — or simply a slow first
 * seed — meant the local server never opened its port at all and looked exactly
 * like the production "stuck loading" symptom. Now the port opens immediately,
 * `GET /` and `GET /api/health` answer straight away, and `/api/*` routes wait on
 * the same bounded bootstrap the serverless path uses.
 */
import createApp from "./app.js";
import { config } from "./config/env.js";
import { bootstrapDatabase } from "./db/init.js";
import { logger } from "./utils/logger.js";
import { closeClient } from "./db/client.js";

async function main(): Promise<void> {
  const app = createApp();

  const server = app.listen(config.port, "0.0.0.0", () => {
    logger.info("[BOOT] server: listening (dev)", {
      port: config.port,
      origins: config.frontendOrigins,
      env: config.nodeEnv,
      db: config.tursoDatabaseUrl ? "remote" : "local-file",
    });
  });

  // Warm the database in the background. Failures are logged, not fatal: the app
  // is already serving, and `/api/health` reports the true dependency state.
  void bootstrapDatabase()
    .then(() => logger.info("[BOOT] database: warm (dev)"))
    .catch((err) =>
      logger.error("[BOOT] database: warm-up failed — /api routes will retry on demand", {
        err: String((err as Error)?.message ?? err),
      }),
    );

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
