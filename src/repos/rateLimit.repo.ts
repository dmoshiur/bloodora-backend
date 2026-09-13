import { get, run } from "../db/query.js";

/**
 * Shared rate-limit counters.
 *
 * The in-process limiter (`src/middleware/rateLimit.ts`) is per instance: on a
 * serverless platform every cold start begins with empty buckets, so an attacker
 * spread across invocations — or simply lucky — can retry a login far more often
 * than the configured window allows. Sensitive scopes therefore ALSO count in the
 * database, which every instance shares.
 *
 * Cost is one round trip per check on the scopes that need it (login, register,
 * password reset, AI, order placement). Public reads stay on the in-process
 * limiter only.
 *
 * State is a fixed-window counter (not a sliding log): bounded storage, no
 * per-request history, and a strict-enough bound for abuse prevention. Rows are
 * deleted once their window has passed.
 */

export interface RateCheck {
  allowed: boolean;
  count: number;
  limit: number;
  resetAt: number;
  retryAfterSec: number;
}

export const rateLimitRepo = {
  /**
   * Register one hit for `bucket` and report whether the caller is still inside
   * the limit. `windowMs` fixes the window length; the bucket resets when it
   * expires.
   */
  async hit(bucket: string, windowMs: number, limit: number): Promise<RateCheck> {
    const now = Date.now();
    const windowEnd = now + windowMs;
    const key = bucket.slice(0, 190);

    // Upsert: start a new window when the stored one has expired, otherwise
    // increment. SQLite evaluates every SET expression against the PRE-update
    // row, so both CASEs see the old window_end.
    //
    // Two statements on purpose. `INSERT … RETURNING` would halve the round
    // trips, but this repo's `run()` discards result rows, and re-running the
    // upsert after a RETURNING failure would double-count the hit.
    await run(
      `INSERT INTO rate_limits (bucket, count, window_end) VALUES (?, 1, ?)
       ON CONFLICT(bucket) DO UPDATE SET
         count = CASE WHEN window_end <= ? THEN 1 ELSE count + 1 END,
         window_end = CASE WHEN window_end <= ? THEN ? ELSE window_end END`,
      [key, windowEnd, now, now, windowEnd],
    );
    const row = await get<{ count: number; window_end: number }>(
      `SELECT count, window_end FROM rate_limits WHERE bucket = ?`,
      [key],
    );

    const count = row?.count ?? 1;
    const resetAt = row?.window_end ?? windowEnd;
    const allowed = count <= limit;
    return {
      allowed,
      count,
      limit,
      resetAt,
      retryAfterSec: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
    };
  },

  /** Reset a bucket (used after a successful login, so failures do not accumulate). */
  async reset(bucket: string): Promise<void> {
    await run(`DELETE FROM rate_limits WHERE bucket = ?`, [bucket.slice(0, 190)]);
  },

  /** Drop every expired window. Called by maintenance/cron. */
  async purge(): Promise<number> {
    const { changes } = await run(`DELETE FROM rate_limits WHERE window_end <= ?`, [Date.now()]);
    return changes;
  },

  async count(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM rate_limits`);
    return row?.n ?? 0;
  },
};
