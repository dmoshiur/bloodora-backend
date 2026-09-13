/**
 * Deadlines for every operation that can block a request.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `@libsql/client`'s HTTP transport contains **no** timeout of any kind — there
 * is not a single `AbortSignal`/`setTimeout` in `lib-esm/http.js`, `node.js` or
 * `web.js`. A Turso host that accepts the TCP connection and then never answers
 * (DNS blackhole, firewall drop, region outage, exhausted connection pool) makes
 * `client.execute()` a promise that **never settles**.
 *
 * Every layer above it `await`ed that promise with no deadline:
 *
 *   request → dbReady middleware → ensureDbReady() → execute() → ∞
 *   request → GET /api/health    → get("SELECT 1")  → execute() → ∞
 *   request → express-session    → TursoSessionStore.get() → execute() → ∞
 *
 * Express has no way to notice, so the response was never written and the client
 * spun on "loading" forever — reproducing exactly as `curl -m 15 → status=000`.
 * On Vercel the same thing surfaces as FUNCTION_INVOCATION_FAILED after the
 * platform's own maxDuration, which looks identical to a hang from the browser.
 *
 * So every blocking primitive here is bounded, and the bound always converts
 * into a *shaped, fast* error (503 + a stable `code`) rather than a stall.
 */

import { clampToRemaining } from "../utils/deadline.js";

/** An operation that gave up waiting. Shaped so the central error handler turns it into 503 JSON. */
export class TimeoutError extends Error {
  readonly status = 503;
  readonly code: string;
  readonly waitedMs: number;
  readonly operation: string;

  /**
   * `messageOverride` exists for the "no budget left at all" case: reporting
   * "timed out after 5000ms" when the invocation had 0ms remaining would send an
   * operator looking at the wrong number.
   */
  constructor(operation: string, ms: number, code = "DB_TIMEOUT", messageOverride?: string) {
    super(messageOverride ?? `${operation} timed out after ${ms}ms`);
    this.name = "TimeoutError";
    this.code = code;
    this.waitedMs = ms;
    this.operation = operation;
  }
}

/** True for anything this module produced (including across module instances). */
export function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof TimeoutError ||
    Boolean(err) &&
      typeof err === "object" &&
      (err as { name?: string }).name === "TimeoutError"
  );
}

/**
 * Reject `p` after `ms` unless it settles first.
 *
 * The timer is `unref()`'d: on a serverless instance a pending timer must not be
 * the thing that keeps the runtime alive after the response is flushed, and in
 * local dev it must not stop `process.exit()`.
 *
 * NOTE: this bounds the *wait*, it does not cancel the underlying work. For DB
 * statements that is the correct trade — the in-flight libSQL request is left to
 * finish or die on its own, and the caller gets a fast, honest 503. Network-level
 * cancellation lives in `timedFetch` below, which does abort the socket.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, operation: string, code?: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p; // 0/negative disables the bound
  // Clamp to the time actually left in this invocation. `ms` is a *configured*
  // ceiling; the request budget is the *real* one. Without this, ten individually
  // bounded calls could still sum past the platform's limit and the function
  // would be killed before any of them reported anything.
  // Outside a request (CLIs, dev boot) remainingMs() is Infinity and this is a
  // no-op, so long-running local work is never truncated.
  const effective = clampToRemaining(ms);
  if (effective <= 0) {
    // Nothing left: fail immediately with the same shaped error the timer would
    // have produced, rather than racing a platform kill.
    return Promise.reject(
      new TimeoutError(operation, 0, code, `${operation} was not attempted — this invocation has no time budget left`),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(operation, effective, code)), effective);
    timer.unref?.();
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * A `fetch` that aborts the socket after `ms`.
 *
 * Injected into `createClient({ fetch })` so the *transport* itself is bounded —
 * this is what actually cancels a hung TCP/TLS read instead of only giving up on
 * waiting for it. `AbortError` is remapped to a `TimeoutError` so callers see one
 * consistent shape whichever layer gave up first.
 */
export function timedFetch(ms: number, operation = "database request"): typeof globalThis.fetch {
  const base: typeof globalThis.fetch = globalThis.fetch;
  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  type FetchInit = Parameters<typeof globalThis.fetch>[1];
  return async function timedFetchImpl(input: FetchInput, init?: FetchInit) {
    if (!Number.isFinite(ms) || ms <= 0) return base(input, init);

    // The client (and therefore this closure) is created ONCE per instance and
    // shared by every request, so the configured `ms` cannot be baked in as the
    // effective deadline — it is re-clamped per call against whatever is left of
    // the current request's budget. This is what stops a database round trip
    // started 9 s into a 10 s invocation from being the thing that runs past it.
    const effective = clampToRemaining(ms);
    if (effective <= 0) {
      throw new TimeoutError(operation, 0, "DB_TIMEOUT", `${operation} was not attempted — this invocation has no time budget left`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effective);
    timer.unref?.();

    // Chain onto a caller-supplied signal so an outer deadline still wins.
    const outer = init?.signal;
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener("abort", () => controller.abort(), { once: true });
    }

    try {
      return await base(input as never, { ...(init as object), signal: controller.signal } as never);
    } catch (err) {
      if ((err as Error)?.name === "AbortError" && !outer?.aborted) {
        throw new TimeoutError(operation, effective);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  } as unknown as typeof globalThis.fetch;
}

/**
 * Bound a whole stage of work (e.g. the cold-start bootstrap) without ever
 * *abandoning* it: the returned promise rejects at the deadline, but `p` keeps
 * running and stays shared with every later caller.
 *
 * That distinction is what makes the bootstrap safe to time out. Resetting the
 * shared promise on a deadline would start a SECOND concurrent bootstrap against
 * the same database — doubling the round trips that were already too slow. Here
 * the first request answers 503 fast, the work continues in the background, and
 * the next request finds it finished.
 */
export function withDeadline<T>(p: Promise<T>, ms: number, operation: string): Promise<T> {
  return withTimeout(p, ms, operation, "DB_NOT_READY");
}
