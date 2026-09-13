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

/**
 * Vercel's Node runtime requires the default export to be a function
 * (request handler). An Express app IS a function, so `export default app`
 * is valid — BUT only if `createApp()` never throws. The previous version
 * did `const app = createApp(); export default app;` at the top level, so
 * a synchronous throw (e.g. from `src/config/env.ts` when production env
 * vars were missing) made the module fail to export at all. Vercel then
 * reported:
 *   "Invalid export found in module '/var/task/server.js'. The default
 *    export must be a function or server."
 *   followed by "Node.js process exited with exit status: 1" and a public
 *   timeout (FUNCTION_INVOCATION_FAILED).
 *
 * Wrap initialization so the module ALWAYS exports a callable handler, even
 * when `createApp()` fails. The handler returns a JSON 500 instead of a
 * timeout, so the deployment stays diagnosable. `src/config/env.ts` now
 * also avoids throwing in production, but this wrapper is a second defense.
 */
let app: ReturnType<typeof createApp> | null = null;
let initError: Error | null = null;
try {
  app = createApp();
} catch (err) {
  initError = err instanceof Error ? err : new Error(String(err));
  logger.error("server: failed to create app — serving init-error handler until restart", {
    err: String(initError.stack ?? initError.message),
  });
}

function handler(req: import("express").Request, res: import("express").Response, next?: import("express").NextFunction): void {
  if (initError || !app) {
    // Always return JSON, never a timeout — keeps the public URL alive and
    // makes the missing-env problem obvious to an operator curling the URL.
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          code: "SERVER_INIT_FAILED",
          message: initError?.message ?? "Server initialization failed",
        },
      });
    }
    return;
  }
  // Express apps are callable as (req,res,next) — delegate.
  (app as unknown as (req: unknown, res: unknown, next?: unknown) => void)(req, res, next);
}

export default handler;
// Also expose for CJS interop (some bundlers resolve default vs module.exports
// differently; exporting both guarantees Vercel sees a function either way).
export { handler };
