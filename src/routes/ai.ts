import { Router } from "express";
import { ah } from "../utils/async.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireAdmin } from "../middleware/admin.js";
import {
  publicConfig,
  chat,
  ask,
  status,
  adminConfigGet,
  adminConfigPost,
  adminTest,
  adminModels,
  adminConversations,
  adminKnowledge,
  knowledgePreview,
} from "../controllers/ai.controller.js";

const router = Router();

// Mounted at /api/ai (admin paths live under /api/ai/admin/* — original contract).
router.get("/config", ah(publicConfig));
router.post("/chat", rateLimit({ scope: "ai-chat", windowMs: 60 * 1000, max: 15 }), ah(chat));
router.post("/ask", rateLimit({ scope: "ai-ask", windowMs: 60 * 1000, max: 10 }), ah(ask));
router.get("/status", ah(status));

// Admin (also reachable via /api/admin/ai legacy mount through adminRouter below).
router.get("/admin/config", requireAdmin, ah(adminConfigGet));
router.post("/admin/config", requireAdmin, ah(adminConfigPost));
router.post("/admin/test", requireAdmin, ah(adminTest));
router.get("/admin/models", requireAdmin, ah(adminModels));
router.get("/admin/conversations", requireAdmin, ah(adminConversations));
router.get("/admin/knowledge", requireAdmin, ah(adminKnowledge));

// Legacy mount compatibility (/api/admin/ai).
export const adminRouter = Router();
adminRouter.get("/config", requireAdmin, ah(adminConfigGet));
adminRouter.post("/config", requireAdmin, ah(adminConfigPost));
adminRouter.post("/test", requireAdmin, ah(adminTest));
adminRouter.get("/models", requireAdmin, ah(adminModels));
adminRouter.get("/conversations", requireAdmin, ah(adminConversations));
adminRouter.get("/knowledge", requireAdmin, ah(adminKnowledge));
adminRouter.get("/preview", requireAdmin, ah(knowledgePreview));

export default router;
