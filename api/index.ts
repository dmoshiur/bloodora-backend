/**
 * Vercel serverless entry — thin wrapper around src/app.
 *
 * Vercel historically serves functions from `api/` automatically. Having an
 * `api/index.ts` ensures the rewrite `/(.*) -> /api` always resolves to a
 * real function, even if the project was linked to expect `server.js` at the
 * root (the previous FUNCTION_INVOCATION_FAILED reported
 * `/var/task/server.js`). The file is intentionally tiny: all logic lives in
 * `src/app.ts` and `src/server.ts` so local `npm run dev` and Vercel use the
 * same code.
 *
 * The wrapper mirrors `src/server.ts`'s defensive init: if `createApp()`
 * throws (e.g. due to a malformed env var) the module still exports a
 * callable handler that returns JSON 500 instead of crashing the function
 * (which Vercel surfaces as "Invalid export must be a function" + timeout).
 */
import createApp from "../src/app.js";
import { logger } from "../src/utils/logger.js";

process.on("uncaughtException", (err) => {
  logger.error("uncaught exception (api, process kept alive)", { err: String((err as Error)?.stack ?? err) });
});
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled rejection (api, process kept alive)", { reason: String((reason as Error)?.stack ?? reason) });
});

let app: ReturnType<typeof createApp> | null = null;
let initError: Error | null = null;
try {
  app = createApp();
} catch (err) {
  initError = err instanceof Error ? err : new Error(String(err));
  logger.error("api: failed to create app — serving init-error handler until restart", {
    err: String(initError.stack ?? initError.message),
  });
}

function handler(req: import("express").Request, res: import("express").Response, next?: import("express").NextFunction): void {
  if (initError || !app) {
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
  (app as unknown as (req: unknown, res: unknown, next?: unknown) => void)(req, res, next);
}

export default handler;
export { handler };
