/**
 * Production / serverless entry point (Vercel Functions).
 *
 * The default export is the Express application itself. An Express app IS a
 * request handler (function(req, res)), which is exactly what Vercel's Node
 * runtime requires:
 *
 *   "Invalid export found in module /var/task/server.js —
 *    The default export must be a function or server."
 *
 * There is deliberately NO app.listen() here: the platform owns the HTTP
 * server and the process lifecycle. Local development uses src/dev.ts.
 *
 * Database bootstrap is lazy + memoized (ensureDbReady) inside the app, so
 * the first request on a cold instance pays the init cost once and every
 * later request reuses it — no cross-instance in-memory state is assumed.
 */
import createApp from "./app.js";
import { logger } from "./utils/logger.js";

// Last-resort process backstops. All request-level errors are already handled
// by ah() + the central errorHandler; these exist so that a pathological
// request (or a library edge case) logs loudly instead of killing the whole
// instance — with all app state living in Turso, surviving a stray
// unhandled rejection is safe and strictly better than a DoS-able crash.
process.on("uncaughtException", (err) => {
  logger.error("uncaught exception (process kept alive)", { err: String(err?.stack ?? err) });
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection (process kept alive)", { reason: String((reason as Error)?.stack ?? reason) });
});

const app = createApp();

export default app;
