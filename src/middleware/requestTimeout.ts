import type { NextFunction, Request, Response } from "express";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Two guarantees, in one cheap middleware:
 *
 * 1. **No request can stay pending forever.** Every operation on the critical
 *    path now has its own deadline (DB statement, batch, bootstrap, session
 *    store, AI call, SMTP socket), but a deadline per operation is not the same
 *    as a deadline per request: a handler that `await`s ten bounded calls in
 *    sequence can still outlive the platform's patience. This is the outer
 *    failsafe. It fires only when `REQUEST_TIMEOUT_MS` elapses *and* nothing has
 *    been written yet, so it can never truncate a legitimate response.
 *
 * 2. **Every request is accounted for in the logs.** `[RESPONSE]` records the
 *    method, path, status and duration. When something does stall, the last
 *    `[REQUEST]`-side breadcrumb plus the absence of a matching `[RESPONSE]`
 *    names the route immediately — which is how the original hang was traced.
 *    Bodies, cookies, tokens and query strings are never logged.
 */

/** Requests slower than this are logged at `warn` regardless of LOG_LEVEL. */
const SLOW_MS = 2_000;

/** Paths that legitimately hold the socket open (SSE). Prefix/suffix match. */
function isStreaming(req: Request): boolean {
  const accept = String(req.headers.accept ?? "");
  return accept.includes("text/event-stream");
}

export function requestTimeout(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  const path = req.originalUrl.split("?")[0]; // never log query strings
  const streaming = isStreaming(req);

  logger.debug("[REQUEST]", { method: req.method, path });

  let timer: NodeJS.Timeout | undefined;
  if (config.requestTimeoutMs > 0) {
    timer = setTimeout(() => {
      const ms = Date.now() - started;
      if (res.headersSent) {
        // The handler already owns the socket (an SSE stream, a chunked
        // download). Writing a status now would corrupt it, so only report.
        logger.warn("[TIMEOUT] response still streaming past the request deadline", {
          method: req.method,
          path,
          ms,
        });
        return;
      }
      logger.error("[TIMEOUT] request did not complete — answering 504 instead of hanging", {
        method: req.method,
        path,
        ms,
        limitMs: config.requestTimeoutMs,
      });
      res.status(504).json({
        error: {
          code: "REQUEST_TIMEOUT",
          message: "The server took too long to handle this request. Please try again.",
        },
      });
    }, config.requestTimeoutMs);
    // Must not be the reason a serverless instance stays alive after the
    // response is flushed, and must not block `process.exit()` in local dev.
    timer.unref?.();
  }

  let finished = false;
  const done = () => {
    // `finish` and `close` both fire on a normal response; log it exactly once.
    if (finished) return;
    finished = true;
    if (timer) clearTimeout(timer);
    const ms = Date.now() - started;
    const line = { method: req.method, path, status: res.statusCode, ms };
    // 5xx that we chose (503 DB not ready, 504 timeout) is a service condition,
    // not a bug — warn. Anything else at 500+ is worth an error line.
    if (res.statusCode >= 500 && res.statusCode !== 503) logger.error("[RESPONSE]", line);
    else if (res.statusCode >= 400) logger.warn("[RESPONSE]", line);
    else if (ms >= SLOW_MS) logger.warn("[RESPONSE] slow", line);
    else if (streaming) logger.debug("[RESPONSE] stream ended", line);
    else logger.debug("[RESPONSE]", line);
  };

  res.once("finish", done);
  res.once("close", done);
  next();
}
