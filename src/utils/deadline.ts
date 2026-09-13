import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The request-scoped deadline — the one thing that makes "every operation has a
 * timeout" actually add up to "every REQUEST has a timeout".
 *
 * ============================== WHY THIS EXISTS ==============================
 * Per-operation deadlines are necessary but NOT sufficient. A handler that
 * awaits ten individually-bounded calls in sequence can still outlive the
 * platform's function limit, because nothing was bounding the *sum*:
 *
 *   POST /api/ai/chat          25 s per attempt x 2 attempts + backoff = 50.4 s
 *   POST /api/admin/mail/flush up to 50 sequential SMTP sends x ~24 s each
 *   POST /api/admin/maintenance  mail flush + 6 prune tasks, sequentially
 *
 * Vercel's limit for this project is 10 s (`maxDuration` in vercel.json). Every
 * one of the above was killed by the platform mid-flight, which is reported as
 *
 *   504: GATEWAY_TIMEOUT  /  FUNCTION_INVOCATION_TIMEOUT
 *
 * and — the part that made this look like a frontend bug — the platform answers
 * with an **HTML** error page, not this app's JSON envelope. A frontend doing
 * `await res.json()` throws on HTML, and unless its `catch`/`finally` also clears
 * the spinner the UI loads forever.
 *
 * The fix is not a bigger timeout. It is a single budget, established when the
 * request arrives and visible to every layer beneath it, so that:
 *
 *   - every deadline is clamped to the time actually left;
 *   - loops (mail flush, maintenance) stop between iterations instead of
 *     starting work they cannot finish;
 *   - the outer failsafe in `middleware/requestTimeout.ts` always fires BEFORE
 *     the platform does, so the client always receives a JSON body.
 * ===========================================================================
 */

interface RequestContext {
  /** Epoch ms when the request entered the middleware stack. */
  startedAt: number;
  /** Epoch ms by which a response MUST have been handed to the socket. */
  deadlineAt: number;
  /** Request path, for log lines only (never a query string). */
  path: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` inside a request deadline. `next()` is dispatched synchronously by
 * Express, so every handler and every promise they create inherits this context
 * — which is what lets `db/query.ts` clamp a statement deadline without being
 * told anything about HTTP.
 */
export function runWithDeadline<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The active request's context, or undefined outside a request (CLIs, dev boot). */
export function currentDeadline(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Milliseconds left before the platform kills this invocation.
 *
 * `Infinity` outside a request context, so background/CLI work (`npm run
 * db:init`, `src/dev.ts`) is never artificially truncated by a deadline that
 * does not apply to it.
 */
export function remainingMs(): number {
  const ctx = storage.getStore();
  if (!ctx) return Number.POSITIVE_INFINITY;
  return ctx.deadlineAt - Date.now();
}

/** How long this request has been running, in ms. */
export function elapsedMs(): number {
  const ctx = storage.getStore();
  return ctx ? Date.now() - ctx.startedAt : 0;
}

/**
 * Clamp a deadline so it cannot outlive the request.
 *
 * `ms <= 0` means "no bound" by this codebase's convention and is passed through
 * untouched — disabling a deadline is an explicit operator choice, not something
 * this helper should silently override.
 */
export function clampToRemaining(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return ms;
  const left = remainingMs();
  if (!Number.isFinite(left)) return ms;
  return Math.max(0, Math.min(ms, Math.floor(left)));
}

/** True when there is not enough time left to do `neededMs` of work. */
export function budgetExhausted(neededMs = 0): boolean {
  return remainingMs() <= neededMs;
}

/**
 * Thrown when a handler is about to start work it cannot finish in time.
 *
 * Shaped like every other service error in this app (`status` + `code`) so the
 * central error handler turns it into a JSON 504 the frontend can parse — which
 * is the entire point: a fast, readable 504 from us beats an HTML 504 from the
 * platform, because only the former lets the client clear its loading state.
 */
export class BudgetExhaustedError extends Error {
  readonly status = 504;
  readonly code = "FUNCTION_BUDGET_EXHAUSTED";
  readonly operation: string;
  readonly remainingMs: number;

  constructor(operation: string, remaining: number) {
    super(`Not enough time left in this invocation to ${operation} (${Math.max(0, Math.round(remaining))}ms remaining)`);
    this.name = "BudgetExhaustedError";
    this.operation = operation;
    this.remainingMs = Math.max(0, Math.round(remaining));
  }
}

/**
 * Guard for loops and multi-step handlers: throw unless at least `neededMs`
 * remains. Call it at the TOP of each iteration, before starting new work.
 */
export function requireBudget(operation: string, neededMs = 250): void {
  const left = remainingMs();
  if (left <= neededMs) throw new BudgetExhaustedError(operation, left);
}
