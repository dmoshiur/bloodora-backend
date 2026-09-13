import type { Request, Response } from "express";
import { get } from "../db/query.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Baked in at build time rather than read from package.json at runtime: on
 * Vercel only the compiled `dist/` tree is guaranteed to be present, so a
 * runtime `readFileSync("../package.json")` would be the one thing that can make
 * the health probe itself fail.
 */
const APP_VERSION = "2.0.0";

/**
 * GET /api/health — deployment health probe.
 * Returns db:"ok" only when a live SELECT 1 round-trip succeeds, so load
 * balancers and Vercel can distinguish "process up" from "process + DB up".
 */
export async function health(_req: Request, res: Response): Promise<void> {
  let db = "ok";
  let dbMs: number | null = null;
  try {
    const started = Date.now();
    await get(`SELECT 1 AS ok`);
    dbMs = Date.now() - started;
  } catch (err) {
    db = "error";
    logger.warn("health: database check failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const ok = db === "ok";
  res.status(ok ? 200 : 503).json({
    // `success` matches the envelope every other endpoint uses, so a monitor can
    // treat /api/health like any other call; `status` keeps the probe vocabulary
    // (ok | degraded) that uptime checks and the frontend's /health proxy show.
    success: ok,
    status: ok ? "ok" : "degraded",
    service: "bloodora-backend",
    version: APP_VERSION,
    db,
    dbMs,
    env: config.nodeEnv,
    time: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
}
