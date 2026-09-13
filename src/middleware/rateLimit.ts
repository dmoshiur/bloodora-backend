import type { Request, Response, NextFunction, RequestHandler } from "express";
import { rateLimitRepo } from "../repos/rateLimit.repo.js";
import { translate } from "../i18n/index.js";
import { logger } from "../utils/logger.js";

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Rate limiting.
 *
 * Two layers, deliberately:
 *
 *  1. **In-process fixed window** — free, instant, and effective against a single
 *     client hammering one warm instance. It is per instance by design: a rate
 *     limit is a protective heuristic, and losing it on a cold start is harmless.
 *
 *  2. **Shared database window** (`shared: true`) — required for the scopes where
 *     "try again on a new instance" must not reset the counter: login, register,
 *     password reset, AI calls and order placement. Without it a serverless
 *     deployment effectively has no limit on credential stuffing. If the shared
 *     store is unreachable the layer fails OPEN (the request proceeds under the
 *     in-process limit only) — a database blip must not lock every user out.
 *
 * Rejections are `429` with a `Retry-After` header and the standard error
 * envelope, so a client can back off correctly instead of guessing.
 */
const buckets = new Map<string, Window>();

let lastPrune = 0;
function prune(now: number): void {
  if (now - lastPrune < 60_000) return;
  lastPrune = now;
  for (const [key, w] of buckets) {
    if (w.resetAt <= now) buckets.delete(key);
  }
}

function localHit(key: string, windowMs: number, max: number): Window {
  const now = Date.now();
  prune(now);
  let w = buckets.get(key);
  if (!w || w.resetAt <= now) {
    w = { count: 0, resetAt: now + windowMs };
    buckets.set(key, w);
  }
  w.count += 1;
  return w;
}

export interface RateLimitOptions {
  /** Bucket name; also reported back to the client in `X-RateLimit-Scope`. */
  scope?: string;
  windowMs?: number;
  max?: number;
  /** Count in the shared store as well (serverless-safe). */
  shared?: boolean;
  /**
   * Additional discriminator(s) beyond the client IP — e.g. the submitted email
   * on login. Bucketing by account stops an attacker who rotates IPs; bucketing
   * by IP stops one account from locking out a shared NAT. Sensitive scopes use
   * both.
   */
  keyBy?: (req: Request) => string | undefined | null;
}

function clientIp(req: Request): string {
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

/** Build the shared-store bucket name for a request. */
function sharedKey(scope: string, req: Request, extra?: string | null): string {
  const ip = clientIp(req).replace(/[^a-zA-Z0-9.:-]/g, "");
  return extra ? `rl:${scope}:${ip}:${extra}` : `rl:${scope}:${ip}`;
}

function reject(req: Request, res: Response, retryAfterSec: number, scope: string, count: number): void {
  const lang = req.lang ?? "en";
  res.setHeader("Retry-After", String(retryAfterSec));
  res.setHeader("X-RateLimit-Scope", scope);
  logger.warn("rate limit exceeded", { scope, ip: clientIp(req), count, retryAfterSec });
  res.status(429).json({
    error: {
      code: "RATE_LIMITED",
      message: translate(lang, "error.rate_limited"),
      retry_after: retryAfterSec,
    },
  });
}

export function rateLimit(opts: RateLimitOptions = {}): RequestHandler {
  const windowMs = opts.windowMs ?? 15 * 60 * 1000;
  const max = opts.max ?? 10;
  const scope = opts.scope || "global";

  return (req: Request, res: Response, next: NextFunction): void => {
    const extra = opts.keyBy ? (opts.keyBy(req) || "").toLowerCase().slice(0, 120) : "";

    // Layer 1 — in process.
    const local = localHit(`${scope}:${clientIp(req)}${extra ? `:${extra}` : ""}`, windowMs, max);
    if (local.count > max) {
      reject(req, res, Math.max(1, Math.ceil((local.resetAt - Date.now()) / 1000)), scope, local.count);
      return;
    }

    if (!opts.shared) {
      next();
      return;
    }

    // Layer 2 — shared. Fail open on any store error.
    void (async () => {
      try {
        const check = await rateLimitRepo.hit(sharedKey(scope, req, extra), windowMs, max);
        if (!check.allowed) {
          reject(req, res, check.retryAfterSec, scope, check.count);
          return;
        }
        next();
      } catch (err) {
        logger.warn("rate limit: shared store unavailable — continuing on the local window", {
          scope,
          err: String((err as Error)?.message ?? err),
        });
        next();
      }
    })();
  };
}

/**
 * Clear the shared counters for a scope+request after a SUCCESSFUL operation.
 * A correct password should not inherit the failures that preceded it.
 */
export async function resetSharedLimit(scope: string, req: Request, extra?: string | null): Promise<void> {
  const normalized = (extra || "").toLowerCase().slice(0, 120);
  try {
    await rateLimitRepo.reset(sharedKey(scope, req, normalized));
    if (normalized) await rateLimitRepo.reset(sharedKey(scope, req, ""));
  } catch {
    /* best effort */
  }
}
