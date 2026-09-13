import type { Request, Response } from "express";
import { ApiError } from "../utils/errors.js";
import { aiService, MODEL_CHOICES, DEFAULT_MODEL } from "../services/ai.service.js";
import { str } from "../utils/validate.js";

// ---------------------------- public ----------------------------

/** GET /api/ai/config */
export async function publicConfig(_req: Request, res: Response): Promise<void> {
  res.json(await aiService.publicConfig());
}

/** POST /api/ai/chat — {message, conversation_id?, language?, user_id?} */
export async function chat(req: Request, res: Response): Promise<void> {
  const out = await aiService.chat(req.body as Record<string, unknown>);
  res.json(out);
}

/** Legacy keep-alive endpoint. */
export async function ask(req: Request, res: Response): Promise<void> {
  const out = await aiService.ask(str(req.body.question) ?? str(req.body.message) ?? "");
  res.json({ success: true, ...out });
}

/** GET /api/ai/status — availability without the key. */
export async function status(_req: Request, res: Response): Promise<void> {
  const cfg = await aiService.getConfig();
  res.json({ success: true, available: cfg.available, enabled: cfg.enabled === 1, model: cfg.model, provider: cfg.provider });
}

// ----------------------------- admin -----------------------------

/** GET /api/ai/admin/config */
export async function adminConfigGet(_req: Request, res: Response): Promise<void> {
  res.json(await aiService.adminConfig());
}

/** POST /api/ai/admin/config */
export async function adminConfigPost(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const out = await aiService.adminSaveConfig(req.user, req.body as Record<string, unknown>);
  res.json(out);
}

/** POST /api/ai/admin/test */
export async function adminTest(req: Request, res: Response): Promise<void> {
  const out = await aiService.adminTest(req.body as Record<string, unknown>);
  res.json(out);
}

/** GET /api/ai/admin/models */
export async function adminModels(_req: Request, res: Response): Promise<void> {
  res.json(await aiService.adminModels());
}

/** GET /api/ai/admin/conversations */
export async function adminConversations(_req: Request, res: Response): Promise<void> {
  res.json(await aiService.adminConversations());
}

/** GET /api/ai/admin/knowledge */
export async function adminKnowledge(_req: Request, res: Response): Promise<void> {
  res.json(await aiService.adminKnowledge());
}

/** GET /api/ai/admin/preview — legacy alias of knowledge. */
export async function knowledgePreview(_req: Request, res: Response): Promise<void> {
  res.json(await aiService.knowledgePreview());
}

export { MODEL_CHOICES, DEFAULT_MODEL };
