import type { Request, Response, NextFunction } from "express";
import { ApiError } from "../utils/errors.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

interface ShapedError {
  status?: number;
  code?: string;
  message?: string;
  details?: unknown;
  issues?: Array<{ field: string; message: string }>;
  type?: string;
}

/** 404 for anything that fell through the routers. */
export function notFoundHandler(_req: Request, res: Response): void {
  if (res.headersSent) return;
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found" } });
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
      err: err instanceof Error ? err.message : String(err),
    });
    return;
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
      err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
    });
  } else if (status >= 500) {
    logger.warn("service unavailable", { path: req.originalUrl, method: req.method, status, code, message });
  } else if (status === 401 || status === 403) {
    logger.warn("auth rejection", { path: req.originalUrl, status, code });
  }

  const errorObj: Record<string, unknown> = { code, message };
  if (details !== undefined) errorObj.details = details;
  if (issues) errorObj.issues = issues;
  // A 504 we produced means the invocation ran out of time. Say so explicitly and
  // tell the client it is safe to retry, so a frontend can clear its spinner and
  // offer a retry instead of waiting on a response that will never come.
  if (status === 504) {
    errorObj.retryable = true;
    res.setHeader("Retry-After", "1");
  }
  res.status(status).json({ error: errorObj });
}
