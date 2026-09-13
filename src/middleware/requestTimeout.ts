import type { NextFunction, Request, Response } from "express";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { runWithDeadline } from "../utils/deadline.js";

/**
 * Two guarantees, in one cheap middleware:
 *
 * 1. **No request can stay pending forever — and none can be killed by the
 *    platform first.** Every operation on the critical path has its own deadline
 *    (DB statement, batch, bootstrap, session store, AI call, SMTP socket), but a
 *    deadline per operation is not a deadline per request: a handler that
 *    `await`s ten bounded calls in sequence, or loops fifty SMTP sends, can still
 *    outlive the invocation. Measured before this existed:
 *
 *      POST /api/ai/chat           50.4 s   (25 s per attempt x 2 + backoff)
 *      POST /api/admin/mail/flush  up to 50 sequential sends x ~24 s
 *
 *    Vercel's limit is 10 s, so it killed those invocations and answered with an
 *    HTML `504: GATEWAY_TIMEOUT / FUNCTION_INVOCATION_TIMEOUT` — which is also
 *    why the frontend spun forever: `await res.json()` throws on HTML, and a
 *    spinner cleared only in the success path never clears.
 *
 *    This middleware therefore (a) establishes the request-scoped budget every
 *    layer beneath it clamps to — see `utils/deadline.ts` — and (b) arms a
 *    last-resort timer that fires *inside* the platform's limit, so the client
 *    always receives a JSON envelope this app produced.
 *
 *    The last-resort timer is deliberately the LAST thing to fire: `deadlineAt`
 *    (which every operation is clamped to) comes first, so a caller gets the
 *    specific reason — `AI_TIMEOUT`, `DB_TIMEOUT` — and only gets the generic
 *    `REQUEST_TIMEOUT` if a handler somehow swallowed it.
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

  // Work deadline: operations clamp themselves to this. Falls back to the whole
  // budget when the failsafe is disabled (REQUEST_TIMEOUT_MS=0), because leaving
  // a request completely unbounded on a serverless platform is never correct —
  // the invocation still dies at maxDuration whether or not we acknowledged it.
  const workDeadlineMs = config.requestTimeoutMs > 0 ? config.requestTimeoutMs : config.budgetMs;

  // Grace between "operations have given up" and "we write the generic 504".
  // Small, and it must keep the write comfortably inside maxDuration — that is
  // what `responseReserveMs` is held back for.
  const graceMs = Math.min(250, Math.max(50, Math.floor(config.responseReserveMs / 2)));

  let timer: NodeJS.Timeout | undefined;
  /** Set once we own the response; a late handler write must not corrupt it. */
  let answeredByFailsafe = false;

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
      answeredByFailsafe = true;
      logger.error("[TIMEOUT] request did not complete — answering 504 before the platform kills the invocation", {
        method: req.method,
        path,
        ms,
        limitMs: config.requestTimeoutMs,
        platformMaxDurationMs: config.functionMaxDurationMs,
      });
      // Same envelope every other 504 in this app uses (see middleware/error.ts),
      // including `retryable` and `Retry-After`. This path does not go through the
      // central error handler, so the fields are set here — a frontend that keys
      // off `retryable` to clear its spinner and offer a retry must see the same
      // shape whichever layer gave up.
      res.setHeader("Retry-After", "1");
      res.status(504).json({
        error: {
          code: "REQUEST_TIMEOUT",
          message: "The server took too long to handle this request. Please try again.",
          retryable: true,
          elapsedMs: ms,
        },
      });
    }, config.requestTimeoutMs + graceMs);
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
    const line = { method: req.method, path, status: res.statusCode, ms, failsafe: answeredByFailsafe };
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

  // Everything below runs inside the deadline: db/query.ts, the session store,
  // the AI service and the mail loops all read `remainingMs()` from here without
  // knowing anything about HTTP. Express dispatches `next()` synchronously, so
  // the handlers and the promises they create inherit this context.
  runWithDeadline({ startedAt: started, deadlineAt: started + workDeadlineMs, path }, () => next());
}
