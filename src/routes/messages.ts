import { Router } from "express";
import { ah } from "../utils/async.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import {
  inbox,
  send,
  read,
  original,
  reply,
  adminList,
  adminReply,
} from "../controllers/message.controller.js";

// Mounted at /api/messages.
const router = Router();
router.get("/", requireAuth, ah(inbox));
router.post("/", requireAuth, rateLimit({ scope: "message-send", windowMs: 15 * 60 * 1000, max: 20 }), ah(send));
router.get("/:id", requireAuth, ah(read));
router.get("/:id/original", requireAuth, ah(original));
router.post("/:id/reply", requireAuth, rateLimit({ scope: "message-reply", windowMs: 15 * 60 * 1000, max: 20 }), ah(reply));

// Admin mailbox — also reachable at /api/admin/messages (see index).
router.get("/admin/list", requireAdmin, ah(adminList));
router.post("/admin/reply/:id", requireAdmin, ah(adminReply));

export default router;
