import { Router } from "express";
import { ah } from "../utils/async.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requirePermission } from "../middleware/rbac.js";
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
router.get("/admin/config", requirePermission("ai.configure"), ah(adminConfigGet));
router.post("/admin/config", requirePermission("ai.configure"), ah(adminConfigPost));
router.post("/admin/test", requirePermission("ai.configure"), ah(adminTest));
router.get("/admin/models", requirePermission("ai.configure"), ah(adminModels));
router.get("/admin/conversations", requirePermission("ai.configure"), ah(adminConversations));
router.get("/admin/knowledge", requirePermission("ai.configure"), ah(adminKnowledge));

// Legacy mount compatibility (/api/admin/ai).
export const adminRouter = Router();
adminRouter.get("/config", requirePermission("ai.configure"), ah(adminConfigGet));
adminRouter.post("/config", requirePermission("ai.configure"), ah(adminConfigPost));
adminRouter.post("/test", requirePermission("ai.configure"), ah(adminTest));
adminRouter.get("/models", requirePermission("ai.configure"), ah(adminModels));
adminRouter.get("/conversations", requirePermission("ai.configure"), ah(adminConversations));
adminRouter.get("/knowledge", requirePermission("ai.configure"), ah(adminKnowledge));
adminRouter.get("/preview", requirePermission("ai.configure"), ah(knowledgePreview));

export default router;
