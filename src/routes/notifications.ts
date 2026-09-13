import { Router } from "express";
import { ah } from "../utils/async.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import * as c from "../controllers/notification.controller.js";

/**
 * Mounted at /api/notifications — the signed-in caller's in-app feed.
 *
 * Read/unread state is derived from the session, never from a `user_id`
 * parameter, so one account cannot read or clear another's notifications.
 * Admins additionally see the shared admin desk rows.
 */
const router = Router();

router.use(requireAuth);

router.get("/", ah(c.list));
router.get("/unread", ah(c.unread));
// `/read-all` is declared before `/:id/read` so `read-all` is not captured as an id.
router.post("/read-all", ah(c.markAllRead));
router.post("/:id/read", rateLimit({ scope: "notify-read", windowMs: 60 * 1000, max: 120 }), ah(c.markRead));
router.delete("/:id", ah(c.remove));

export default router;
