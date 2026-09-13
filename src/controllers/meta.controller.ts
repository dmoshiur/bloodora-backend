import type { Request, Response } from "express";
import { metaService } from "../services/meta.service.js";

/** GET /api/meta — site-wide metadata for the frontend (cacheable, no secrets). */
export async function meta(_req: Request, res: Response): Promise<void> {
  const result = await metaService.get();
  res.json(result);
}
