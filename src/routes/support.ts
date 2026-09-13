import { Router } from "express";
import { ah } from "../utils/async.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { optionalAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
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
adminRouter.use(requireAdmin);
adminRouter.get("/sessions", ah(adminSessions));
adminRouter.get("/sessions/:key/messages", ah(adminMessages));
adminRouter.post("/sessions/:key/reply", rateLimit({ scope: "support-reply", windowMs: 60 * 1000, max: 60 }), ah(adminReply));
adminRouter.post("/sessions/:key/close", ah(adminClose));
adminRouter.get("/stream", adminStream);

export default router;
