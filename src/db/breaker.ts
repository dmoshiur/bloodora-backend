/**
 * The steady-state database breaker: fail fast while Turso is down.
 *
 * ============================== WHY THIS EXISTS =============================
 * Measured with the real remote transport against a database that stopped
 * answering (`tests/remote.test.mts`, phase 4):
 *
 *     GET /api/shop/products  →  503 in 5006 ms     (DB_TIMEOUT_MS = 5000)
 *
 * Bounded, so not the original hang — but 5 s is half of a 10 s invocation, and
 * the frontend that called us is a server-rendered function on the SAME 10 s
 * clock. One page render makes several API calls; two of them at 5 s each and the
 * platform kills the *caller*, answering the browser with an HTML 504 nobody can
 * parse. During an outage every request therefore paid the full deadline before
 * saying "the database is down", which is the most expensive possible way to say
 * it.
 *
 * So once a handful of consecutive calls have failed at the transport layer we
 * stop *starting* new ones: the answer is a shaped 503 in about a millisecond
 * until a trial request succeeds.
 *
 * Two properties matter and are easy to get wrong:
 *
 *   - **Only transport failures trip it.** A `SQLITE_CONSTRAINT_UNIQUE` (which is
 *     how `EMAIL_TAKEN` is detected) or a bad column name says nothing about
 *     Turso's health; counting those would let one buggy query take the whole API
 *     offline. `isDbDependencyError()` is the filter.
 *   - **It must recover by itself.** After the cooldown exactly one trial request
 *     is admitted (half-open); if it succeeds the breaker closes and normal
 *     service resumes on the same instance — no redeploy, no restart. The health
 *     probe deliberately bypasses the gate so it can always *tell the truth* and
 *     act as that trial.
 * ===========================================================================
 */

import { logger } from "../utils/logger.js";
import { dbUnavailable, dbUnavailableError, isDbDependencyError, publicReason, type DbFailureReason } from "./errors.js";

/** Consecutive transport failures before we stop starting new work. */
const FAILURE_THRESHOLD = Math.max(1, Number(process.env.DB_BREAKER_THRESHOLD ?? "") || 3);
/** How long the breaker stays fully open before admitting a trial request. */
const COOLDOWN_MS = Math.max(250, Number(process.env.DB_BREAKER_COOLDOWN_MS ?? "") || 2_000);
/** An outage must not turn into a tight retry loop against a dead host. */
const MAX_COOLDOWN_MS = Math.max(COOLDOWN_MS, Number(process.env.DB_BREAKER_MAX_COOLDOWN_MS ?? "") || 10_000);

export type BreakerState = "closed" | "open" | "half-open";

interface State {
  failures: number;
  openedAt: number;
  /** Set while a half-open trial is in flight, so only one is admitted. */
  trialInFlight: boolean;
  /** Grows while an outage lasts; bounded by MAX_COOLDOWN_MS. */
  backoff: number;
  lastStateLog: number;
  /** Why we are open, so a refused request reports the real category. */
  lastReason: DbFailureReason;
}

const state: State = {
  failures: 0,
  openedAt: 0,
  trialInFlight: false,
  backoff: COOLDOWN_MS,
  lastStateLog: 0,
  lastReason: "unreachable",
};

function cooldown(): number {
  return Math.min(MAX_COOLDOWN_MS, Math.max(COOLDOWN_MS, state.backoff));
}

export const dbBreaker = {
  /** Current state, for the health endpoint and logs. */
  state(): BreakerState {
    if (state.openedAt === 0) return "closed";
    return Date.now() - state.openedAt >= cooldown() ? "half-open" : "open";
  },

  /** Consecutive transport failures observed so far. */
  failures(): number {
    return state.failures;
  },

  /**
   * May a data-path request start a database call right now?
   *
   * `probe: true` bypasses the gate — used by `GET /api/health`, whose whole job
   * is to report the truth (and which therefore doubles as the half-open trial).
   */
  allow(probe = false): boolean {
    if (probe) return true;
    if (state.openedAt === 0) return true;
    if (Date.now() - state.openedAt < cooldown()) return false;
    // Half-open: admit one trial at a time, deny the rest until it settles.
    if (state.trialInFlight) return false;
    state.trialInFlight = true;
    return true;
  },

  /** A database call succeeded: close the breaker. */
  noteSuccess(operation = "db"): void {
    if (state.failures > 0 || state.openedAt > 0) {
      logger.info("db: breaker closed — database responding again", {
        operation,
        wasOpenForMs: state.openedAt ? Date.now() - state.openedAt : 0,
        previousFailures: state.failures,
      });
    }
    state.failures = 0;
    state.openedAt = 0;
    state.trialInFlight = false;
    state.backoff = COOLDOWN_MS;
    state.lastReason = "unreachable";
  },

  /**
   * A database call failed. Returns the error the caller should throw: the
   * original for anything that is not a dependency failure, a shaped 503 for one.
   */
  noteFailure(err: unknown, operation: string): unknown {
    if (!isDbDependencyError(err)) {
      // Not a health signal — but do release a half-open trial slot, otherwise a
      // SQL bug arriving mid-trial would wedge the breaker shut.
      state.trialInFlight = false;
      return err;
    }

    state.failures += 1;
    state.lastReason = publicReason(err);
    const now = Date.now();
    if (state.openedAt === 0) {
      if (state.failures >= FAILURE_THRESHOLD) {
        state.openedAt = now;
        state.backoff = COOLDOWN_MS;
        logger.error("db: breaker OPEN — failing fast until the database responds", {
          operation,
          failures: state.failures,
          reason: publicReason(err),
          cooldownMs: cooldown(),
          // Server-side only: the driver message may name the host.
          detail: String((err as Error)?.message ?? err).slice(0, 300),
        });
      }
    } else {
      // A half-open trial failed: restart the cooldown with a modest backoff.
      const previous = now - state.openedAt;
      state.openedAt = now;
      state.backoff = Math.min(MAX_COOLDOWN_MS, Math.max(COOLDOWN_MS, previous * 2));
      if (now - state.lastStateLog > 5_000) {
        state.lastStateLog = now;
        logger.warn("db: breaker still open — trial request failed", {
          operation,
          reason: publicReason(err),
          cooldownMs: cooldown(),
        });
      }
    }
    state.trialInFlight = false;
    return dbUnavailableError(err, operation, Math.max(500, cooldown()));
  },

  /**
   * The shaped rejection used when the gate is closed. Built per call so the
   * caller's operation name and the remaining cooldown are accurate.
   */
  refuse(operation: string): Error {
    const remaining = state.openedAt > 0 ? cooldown() - (Date.now() - state.openedAt) : 0;
    // Built without a log line: the transitions are already logged above, and one
    // line per refused request would bury them during exactly the outage where an
    // operator is reading the log.
    return dbUnavailable(state.lastReason, Math.max(500, remaining));
  },

  /** Test/CLI helper: forget everything. */
  reset(): void {
    state.failures = 0;
    state.openedAt = 0;
    state.trialInFlight = false;
    state.backoff = COOLDOWN_MS;
    state.lastStateLog = 0;
    state.lastReason = "unreachable";
  },
};

/**
 * Remaining cooldown in whole seconds, for the `Retry-After` header the error
 * handler sets on a 503.
 */
export function breakerRetryAfterSeconds(): number {
  if (state.openedAt === 0) return 1;
  return Math.max(1, Math.ceil((cooldown() - (Date.now() - state.openedAt)) / 1_000));
}

/** Snapshot for the health endpoint — state only, never internals or hosts. */
export function breakerSnapshot(): { state: BreakerState; failures: number; cooldownMs: number } {
  return { state: dbBreaker.state(), failures: state.failures, cooldownMs: state.openedAt ? cooldown() : 0 };
}
