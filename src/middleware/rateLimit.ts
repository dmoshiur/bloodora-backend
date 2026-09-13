import type { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger.js";

interface Window {
  count: number;
  resetAt: number;
}

/**
 * Best-effort sliding-window rate limiter.
 *
 * NOTE: state is per-instance by design — a rate limit is a protective
 * heuristic that must NOT persist (losing it after a cold start is harmless,
 * the real abuse controls are auth + DB-side constraints). Each serverless
 * instance enforces its own window; a shared-store limiter would add latency
 * for no correctness gain here.
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

export function rateLimit(opts: { windowMs?: number; max?: number; scope?: string } = {}) {
  const windowMs = opts.windowMs ?? 15 * 60 * 1000;
  const max = opts.max ?? 10;
  const scope = opts.scope || "global";

  return (req: Request, _res: Response, next: NextFunction): void => {
    const now = Date.now();
    prune(now);
    const key = `${scope}:${req.ip || req.socket.remoteAddress || "?"}`;
    let w = buckets.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      buckets.set(key, w);
    }
    w.count++;
    if (w.count > max) {
      logger.warn("rate limit exceeded", { scope, ip: req.ip, count: w.count });
      next(Object.assign(new Error("Too many requests — please slow down"), { status: 429, code: "RATE_LIMITED" }));
      return;
    }
    next();
  };
}
