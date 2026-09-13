import { Router } from "express";
import { ah } from "../utils/async.js";
import { str } from "../utils/validate.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { reviewService } from "../services/review.service.js";
import { ApiError } from "../utils/errors.js";

const router = Router();

// POST /api/reviews — submit (product review or site testimonial).
router.post(
  "/",
  requireAuth,
  rateLimit({ scope: "review-submit", windowMs: 60 * 60 * 1000, max: 5 }),
  ah(async (req, res) => {
    if (!req.user) throw ApiError.unauthorized();
    const out = await reviewService.submit(req.user, req.body as Record<string, unknown>);
    res.json({ success: true, ...out });
  }),
);

// GET /api/reviews/mine — my reviews.
router.get("/mine", requireAuth, ah(async (req, res) => {
  if (!req.user) throw ApiError.unauthorized();
  res.json(await reviewService.mine(req.user));
}));

// ---------- moderation (also mounted under /api/admin/reviews if needed) ----------

// GET /api/reviews/admin?status=
router.get("/admin", requireAdmin, ah(async (req, res) => {
  res.json(await reviewService.adminList(str(req.query.status) || undefined));
}));

// POST /api/reviews/admin/:id/status
router.post("/admin/:id/status", requireAdmin, ah(async (req, res) => {
  if (!req.user) throw ApiError.unauthorized();
  const message = await reviewService.adminSetStatus(req.user, req.params.id, str(req.body.status) ?? "");
  res.json({ success: true, message });
}));

// POST /api/reviews/admin/:id/feature
router.post("/admin/:id/feature", requireAdmin, ah(async (req, res) => {
  if (!req.user) throw ApiError.unauthorized();
  const message = await reviewService.adminFeature(req.user, req.params.id);
  res.json({ success: true, message });
}));

// POST /api/reviews/admin/:id/reply
router.post("/admin/:id/reply", requireAdmin, ah(async (req, res) => {
  if (!req.user) throw ApiError.unauthorized();
  const message = await reviewService.adminReply(req.user, req.params.id, str(req.body.admin_reply) ?? "");
  res.json({ success: true, message });
}));

// DELETE /api/reviews/admin/:id
router.delete("/admin/:id", requireAdmin, ah(async (req, res) => {
  if (!req.user) throw ApiError.unauthorized();
  const message = await reviewService.adminDelete(req.user, req.params.id);
  res.json({ success: true, message });
}));

export default router;
