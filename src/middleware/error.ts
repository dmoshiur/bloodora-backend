import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/errors.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { classifyDbError, isDbDependencyError, isDriverError } from "../db/errors.js";
import { breakerRetryAfterSeconds } from "../db/breaker.js";
import { requestIdOf } from "./requestId.js";

interface ShapedError {
  status?: number;
  code?: string;
  message?: string;
  details?: unknown;
  issues?: Array<{ field: string; message: string }>;
  type?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

/** 404 for anything that fell through the routers. */
export function notFoundHandler(req: Request, res: Response): void {
  if (res.headersSent) return;
  res.status(404).json(envelope(req, res, 404, "NOT_FOUND", "Not found"));
}

/**
 * The one response shape every failure in this API returns.
 *
 *   {
 *     ok: false,                       // a client can branch without knowing codes
 *     success: false,                  // the field this API's success bodies use
 *     error: { code, message, … },     // the original nested envelope (unchanged)
 *     code, message,                   // flat twins of the two above
 *     requestId                        // quote this in a support conversation
 *   }
 *
 * Why both nested AND flat? The nested `error.code` is this backend's contract and
 * its own test suites read it. The flat `message` is what the deployed frontend
 * actually displays: its API client does `data.message || "Request failed (500)"`,
 * so before the flat twin existed every backend error surfaced in the UI as the
 * generic "Request failed (500)" — a database outage and a validation error looked
 * identical, and neither said what to do. Adding fields is backwards compatible;
 * changing `error` from an object to a string would not have been.
 *
 * `requestId` is echoed on every failure so a user's complaint can be tied to one
 * line in the Vercel log stream.
 */
function envelope(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const requestId = requestIdOf(req);
  if (requestId !== "-" && !res.getHeader("X-Request-Id")) res.setHeader("X-Request-Id", requestId);
  return {
    ok: false,
    success: false,
    error: { code, message, ...(extra ?? {}) },
    code,
    message,
    ...(extra ?? {}),
    requestId,
  };
}

/**
 * Central error handler. Every error — ApiError, shaped errors, Multer errors,
 * JSON parse errors, unknown throws — becomes a consistent JSON envelope:
 *   { error: { code, message, details?, requestId } }
 * Sensitive internals are logged server-side, never returned to the client.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // The request-level failsafe (`middleware/requestTimeout.ts`) may already have
  // answered 504 while this handler was still running. Writing again would throw
  // ERR_HTTP_HEADERS_SENT *inside the error handler* — the one place Express has
  // nothing left to catch it with. Log and stop instead.
  if (res.headersSent || res.writableEnded) {
    logger.warn("error after the response was already sent — dropping", {
      path: req.originalUrl,
      method: req.method,
      requestId: requestIdOf(req),
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Safety net for the classification that normally happens in `src/db/query.ts`:
  // a database call made OUTSIDE that choke point (a future repo using the client
  // directly, a session-store helper, a migration CLI wired into a route) must
  // still not surface as a 500 "we have a bug" when Turso is simply down.
  if (
    !(err instanceof ApiError) &&
    (err as { status?: number })?.status === undefined &&
    isDriverError(err) &&
    isDbDependencyError(err)
  ) {
    err = classifyDbError(err, `${req.method} ${req.originalUrl.split("?")[0]}`);
  }

  let status = 500;
  let code = "INTERNAL";
  let message = "Something went wrong. Please try again.";
  let details: unknown;
  let issues: ShapedError["issues"];

  if (err instanceof ApiError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err && typeof err === "object") {
    const e = err as ShapedError;
    if (typeof e.status === "number" && e.status >= 400 && e.status < 600) {
      status = e.status;
      if (e.code) code = e.code;
      if (e.message) message = e.message;
      if (e.details !== undefined) details = e.details;
      if (Array.isArray(e.issues)) issues = e.issues;
    } else if ((err as ShapedError).type === "entity.parse.failed") {
      status = 400;
      code = "BAD_JSON";
      message = "Request body is not valid JSON";
    } else if ((err as ShapedError).type === "entity.too.large") {
      status = 413;
      code = "PAYLOAD_TOO_LARGE";
      message = "Request body is too large";
    }
  } else if (typeof err === "string") {
    message = err;
  }

  // Log levels distinguish "we chose to fail" from "something broke".
  //
  // An ApiError is a deliberate domain decision (DB not ready, AI unconfigured,
  // delivery area not served). Logging those at `error` with a stack — as this
  // handler used to — buried the genuinely unexpected failures in noise during
  // exactly the debugging session where the signal mattered most.
  if (status >= 500 && !(err instanceof ApiError)) {
    logger.error("unhandled error", {
      path: req.originalUrl,
      method: req.method,
      requestId: requestIdOf(req),
      code,
      err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
    });
  } else if (status >= 500) {
    logger.warn("service unavailable", { path: req.originalUrl, method: req.method, requestId: requestIdOf(req), status, code, message });
  } else if (status === 401 || status === 403) {
    logger.warn("auth rejection", { path: req.originalUrl, requestId: requestIdOf(req), status, code });
  }

  const shaped = (err ?? {}) as ShapedError;
  const extra: Record<string, unknown> = {};
  if (details !== undefined) extra.details = details;
  if (issues) extra.issues = issues;

  // A 504 we produced means the invocation ran out of time, and a 503 means a
  // dependency did. Both are usually transient: say so explicitly (`retryable`)
  // and back it with `Retry-After`, so a client clears its spinner and offers a
  // retry instead of waiting on a response that will never come — or hammering us
  // while the database is still down.
  //
  // The exception is a dependency failure that retrying CANNOT fix: rejected
  // credentials (`DB_AUTH_FAILED`) or a deployment with no database configured
  // (`DB_NOT_CONFIGURED`). Those are operator problems. Marking them retryable
  // makes a well-behaved client loop on a request that will fail identically for
  // as long as the misconfiguration stands — an outage that never ends and never
  // surfaces a reason. The shaped error says so with `retryable: false`, and that
  // answer wins over the status-code default below.
  const transientDbFailure = status === 503 && code.startsWith("DB_");
  const retryable =
    shaped.retryable === false ? false : status === 504 || shaped.retryable === true || transientDbFailure;
  if (retryable) {
    extra.retryable = true;
    const seconds = transientDbFailure
      ? breakerRetryAfterSeconds()
      : Math.max(1, Math.ceil((shaped.retryAfterMs ?? 1_000) / 1_000));
    res.setHeader("Retry-After", String(seconds));
  } else if (transientDbFailure) {
    // Still tell the client the retry is pointless rather than leaving it guessing.
    extra.retryable = false;
  }

  res.status(status).json(envelope(req, res, status, code, message, extra));
}
