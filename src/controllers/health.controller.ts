import type { Request, Response } from "express";
import { get } from "../db/query.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

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
  res.status(db === "ok" ? 200 : 503).json({
    status: db === "ok" ? "ok" : "degraded",
    db,
    dbMs,
    env: config.nodeEnv,
    time: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
}
