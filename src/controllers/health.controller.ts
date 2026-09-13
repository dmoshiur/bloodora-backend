import type { Request, Response } from "express";
import { get } from "../db/query.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { isTimeoutError, withTimeout } from "../db/timeout.js";

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
 * HARD REQUIREMENT: this endpoint must never hang. It is the only way to tell
 * "the function is dead" apart from "the function is up but its database is not",
 * and a probe that stalls answers neither question.
 *
 * So the `SELECT 1` is bounded by `HEALTH_DB_TIMEOUT_MS` (default 1.5 s) *on top
 * of* the transport-level deadline in `getClient()`. Before that bound existed a
 * Turso host that accepted the connection and never replied left this probe
 * pending forever — reproduced as `curl -m 15 /api/health → status=000`.
 *
 * The probe is also exempted in `app.ts` from the session middleware, the DB
 * bootstrap middleware and the language middleware: a browser that has ever
 * logged in sends `connect.sid`, and a session-store read would otherwise put the
 * database back on the critical path of the endpoint whose job is to report on
 * the database.
 */
export async function health(_req: Request, res: Response): Promise<void> {
  let database: "connected" | "unavailable" = "connected";
  let dbMs: number | null = null;
  let dbError: string | null = null;

  const started = Date.now();
  try {
    await withTimeout(get(`SELECT 1 AS ok`), config.healthDbTimeoutMs, "health database probe", "DB_UNAVAILABLE");
    dbMs = Date.now() - started;
  } catch (err) {
    database = "unavailable";
    dbMs = Date.now() - started;
    dbError = isTimeoutError(err) ? `timed out after ${config.healthDbTimeoutMs}ms` : err instanceof Error ? err.message : String(err);
    logger.warn("health: database check failed", { error: dbError });
  }

  const ok = database === "connected";
  res.status(ok ? 200 : 503).json({
    // `success`/`status` keep the envelope every other endpoint uses (and the
    // contract suite asserts `status === "ok"`), while `database` states the
    // dependency explicitly: "connected" | "unavailable".
    success: ok,
    status: ok ? "ok" : "degraded",
    service: "bloodora-backend",
    version: APP_VERSION,
    database,
    // Legacy alias — the existing contract tests and the frontend's /health proxy
    // read `db`. Kept in lockstep with `database`.
    db: ok ? "ok" : "error",
    dbMs,
    ...(dbError ? { dbError } : {}),
    env: config.nodeEnv,
    time: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
}
