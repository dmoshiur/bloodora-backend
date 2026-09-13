import { Router } from "express";
import { ah } from "../utils/async.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireAuth } from "../middleware/auth.js";
import { upload, uploadFile, serveUpload } from "../controllers/upload.controller.js";

const router = Router();

// Mounted at /api/uploads.
router.post("/", requireAuth, rateLimit({ scope: "upload", windowMs: 60 * 1000, max: 20 }), uploadFile, ah(upload));

// GET /api/uploads/:file — alias of the root /uploads/:file mount, so both
// URL shapes work for the frontend.
export const serveRouter = Router();
serveRouter.get("/:file", ah(serveUpload));

export default router;
