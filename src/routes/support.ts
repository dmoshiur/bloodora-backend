import { Router } from "express";
import { ah } from "../utils/async.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { optionalAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import {
  startSession,
  fetchMessages,
  sendMessage,
  streamSession,
  adminSessions,
  adminMessages,
  adminReply,
  adminClose,
  adminStream,
} from "../controllers/support.controller.js";

// Visitor side — mounted at /api/support.
const router = Router();
router.post("/session", optionalAuth, rateLimit({ scope: "support-session", windowMs: 60 * 1000, max: 30 }), ah(startSession));
router.get("/messages", rateLimit({ scope: "support-poll", windowMs: 60 * 1000, max: 120 }), ah(fetchMessages));
router.post("/messages", optionalAuth, rateLimit({ scope: "support-send", windowMs: 60 * 1000, max: 30 }), ah(sendMessage));
router.get("/stream", streamSession);

// Admin side — mounted at /api/support/admin (original contract).
export const adminRouter = Router();
// Reads need `chat.view`; writing needs `chat.reply`, so a moderator can watch
// the desk without being able to answer it.
adminRouter.get("/sessions", requirePermission("chat.view"), ah(adminSessions));
adminRouter.get("/sessions/:key/messages", requirePermission("chat.view"), ah(adminMessages));
adminRouter.post("/sessions/:key/reply", requirePermission("chat.reply"), rateLimit({ scope: "support-reply", windowMs: 60 * 1000, max: 60 }), ah(adminReply));
adminRouter.post("/sessions/:key/close", requirePermission("chat.reply"), ah(adminClose));
// SSE: the guard runs before the stream is opened, and it is deliberately NOT
// wrapped in ah() — a long-lived response must not go through the async wrapper.
adminRouter.get("/stream", requirePermission("chat.view"), adminStream);

export default router;
