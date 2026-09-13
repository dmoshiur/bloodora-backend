import type { Request, Response } from "express";
import { probeQuery } from "../db/query.js";
import { dbBreaker, breakerSnapshot } from "../db/breaker.js";
import { publicReason } from "../db/errors.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { isTimeoutError } from "../db/timeout.js";
import { requestIdOf } from "../middleware/requestId.js";

/**
 * Baked in at build time rather than read from package.json at runtime: on
 * Vercel only the compiled `dist/` tree is guaranteed to be present, so a
 * runtime `readFileSync("../package.json")` would be the one thing that can make
 * the health probe itself fail.
 */
const APP_VERSION = "2.0.0";

/**
 * GET /api/health — deployment health probe.
 *
 * HARD REQUIREMENTS, all of them load-bearing:
 *
 *   1. **It must never hang.** It is the only way to tell "the function is dead"
 *      from "the function is up but its database is not", and a probe that stalls
 *      answers neither question. The `SELECT 1` is bounded by
 *      `HEALTH_DB_TIMEOUT_MS` (default 1.5 s) *on top of* the transport deadline
 *      injected into the libSQL client — before those existed, a Turso host that
 *      accepted the connection and never replied left this probe pending forever
 *      (reproduced as `curl -m 15 /api/health → status=000`).
 *   2. **It must not depend on anything it is reporting on.** `app.ts` exempts it
 *      from the session middleware, the DB bootstrap middleware and the language
 *      middleware; here it uses `probeQuery()`, which bypasses the fast-fail
 *      breaker. A probe that reads our own pessimism instead of the database
 *      would report "unavailable" forever after one blip.
 *   3. **It must be cheap enough to call constantly** — one `SELECT 1`, no schema
 *      work, no seeding, no AI, no SMTP, no external API.
 *   4. **It must be readable by a machine AND by a human at 3am.** `ok` is the
 *      boolean a client branches on, `status` the word an uptime monitor shows,
 *      `database` the dependency named explicitly, and `reason` the leak-free
 *      category when it is down. The host, driver message and SQL stay in the
 *      server log, never in this body.
 *
 * Status codes: 200 when the API can serve traffic, 503 when it cannot. The 503
 * is deliberate — a monitor that only sees 200s would keep a broken deployment in
 * rotation.
 */
export async function health(req: Request, res: Response): Promise<void> {
  const requestId = requestIdOf(req);
  const started = Date.now();
  let database: "connected" | "unavailable" = "connected";
  let dbMs: number | null = null;
  let reason: string | null = null;

  try {
    await probeQuery<{ ok: number }>(`SELECT 1 AS ok`, [], config.healthDbTimeoutMs);
    dbMs = Date.now() - started;
    // A successful probe is the breaker's half-open trial: it reopens the data
    // path on this instance without a redeploy.
    dbBreaker.noteSuccess("health probe");
  } catch (err) {
    database = "unavailable";
    dbMs = Date.now() - started;
    // Coarse category only. `publicReason()` never returns a host, a token, a
    // SQL statement or a driver stack — those go to the log line below.
    reason = isTimeoutError(err) ? "timeout" : publicReason(err);
    dbBreaker.noteFailure(err, "health probe");
    logger.warn("health: database check failed", {
      reason,
      dbMs,
      requestId,
      detail: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
    });
  }

  const ok = database === "connected";
  const breaker = breakerSnapshot();
  res.status(ok ? 200 : 503).json({
    // `ok` is the field a client should branch on; `success`/`status` keep the
    // envelope every other endpoint in this API uses (and the contract suites
    // assert), while `database` names the dependency explicitly.
    ok,
    success: ok,
    status: ok ? "ok" : "degraded",
    service: "bloodora-backend",
    label: "BloodOra API",
    version: APP_VERSION,
    database,
    // Legacy alias — the existing contract tests and the frontend's /health proxy
    // read `db`. Kept in lockstep with `database`.
    db: ok ? "ok" : "error",
    dbMs,
    // Leak-free failure category (`timeout` | `unreachable` | `server_error` |
    // `rate_limited` | `auth_rejected` | `not_configured` | `closed`).
    ...(reason ? { reason } : {}),
    // Whether this instance is currently failing database work fast. Useful to
    // tell "the database is down" from "one slow query".
    breaker: breaker.state,
    env: config.nodeEnv,
    // The platform budget this instance is running under, so a slow-response
    // report can be correlated with the clamps logged at boot.
    budgetMs: config.budgetMs,
    answerByMs: config.answerByMs,
    requestId,
    time: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
}
