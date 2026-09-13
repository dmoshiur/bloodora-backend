import type { NextFunction, Request, Response } from "express";
import crypto from "node:crypto";

/**
 * Correlation IDs.
 *
 * ============================== WHY THIS EXISTS =============================
 * Production logs answered "did the database come up?" and then went silent: the
 * per-request line was logged at `debug`, so on Vercel (LOG_LEVEL=info) an
 * operator could see the boot and nothing after it. There was no way to tell
 * whether requests were arriving, what they returned, or which log line belonged
 * to the browser tab the user was complaining about.
 *
 * A request ID fixes both halves of that:
 *
 *   - every response carries `X-Request-Id`, so a user (or the frontend, or a
 *     support conversation) can quote the exact invocation that failed;
 *   - every log line for that request carries the same ID, so one `grep` in the
 *     Vercel log stream reconstructs the whole lifecycle — middleware, database
 *     round trips, the error, the response status and its duration.
 *
 * Vercel already assigns an invocation ID (`x-vercel-id`) and forwards a client
 * one (`x-request-id`) when present. Reusing an incoming ID rather than minting a
 * new one is what makes the browser's ID, the frontend function's log and this
 * API's log agree — which is the entire point of a correlation ID across a
 * two-function deployment.
 *
 * The ID is deliberately NOT secret-bearing: 16 hex characters, no user data, no
 * timestamp arithmetic, nothing an attacker can enumerate into anything useful.
 * ===========================================================================
 */

const HEADER = "x-request-id";
/** Platform invocation ID, e.g. `iad1::abc-123` — used as a fallback prefix. */
const VERCEL_ID = "x-vercel-id";

declare module "express" {
  interface Request {
    /** Correlation ID for this request; present on every request that reaches us. */
    requestId?: string;
  }
}

/** A short, URL-safe, log-safe ID. */
export function newRequestId(): string {
  return crypto.randomBytes(8).toString("hex");
}

/**
 * Accept an inbound correlation ID only if it is short and boring. A header is
 * attacker-controlled input that ends up in logs and in JSON bodies, so it is
 * length- and character-capped before it is echoed anywhere.
 */
function sanitizeIncoming(value: string | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 80) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(raw)) return null;
  return raw;
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming =
    sanitizeIncoming(Array.isArray(req.headers[HEADER]) ? req.headers[HEADER][0] : req.headers[HEADER]) ??
    // `x-vercel-id` looks like `iad1::uuid`; keep it — it is the platform's own
    // handle on this invocation and it appears in Vercel's log UI.
    sanitizeIncoming(Array.isArray(req.headers[VERCEL_ID]) ? req.headers[VERCEL_ID][0] : req.headers[VERCEL_ID]);

  const id = incoming ? `${incoming}~${newRequestId()}`.slice(0, 96) : newRequestId();
  req.requestId = id;
  res.locals.requestId = id;
  // Echoed on every response, including errors and the failsafe 504, so a client
  // can always quote the invocation it is complaining about.
  if (!res.getHeader(HEADER)) res.setHeader("X-Request-Id", id);
  next();
}

/** The current request's correlation ID, or `-` outside a request context. */
export function requestIdOf(req: { requestId?: string } | undefined): string {
  return req?.requestId || "-";
}
