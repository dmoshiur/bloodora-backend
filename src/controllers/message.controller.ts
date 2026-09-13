import type { Request, Response } from "express";
import { str } from "../utils/validate.js";
import { messageService } from "../services/message.service.js";

/** GET /api/messages — received/sent/unread for the current user. */
export async function inbox(req: Request, res: Response): Promise<void> {
  if (!req.user) throw new Error("LOGIN_REQUIRED");
  res.json(await messageService.inbox(req.user));
}

/** POST /api/messages — send {subject, content, recipient_email?}. */
export async function send(req: Request, res: Response): Promise<void> {
  if (!req.user) throw new Error("LOGIN_REQUIRED");
  const id = await messageService.send(req.user, req.body as Record<string, unknown>);
  res.json({ success: true, id, message: "✅ Message sent successfully!" });
}

/** GET /api/messages/:id — read a message. */
export async function read(req: Request, res: Response): Promise<void> {
  if (!req.user) throw new Error("LOGIN_REQUIRED");
  const message = await messageService.read(req.user, req.params.id);
  res.json({ success: true, message });
}

/** GET /api/messages/:id/original — original for the reply form. */
export async function original(req: Request, res: Response): Promise<void> {
  if (!req.user) throw new Error("LOGIN_REQUIRED");
  const o = await messageService.original(req.user, req.params.id);
  res.json({ success: true, original: o });
}

/** POST /api/messages/:id/reply — {content}. */
export async function reply(req: Request, res: Response): Promise<void> {
  if (!req.user) throw new Error("LOGIN_REQUIRED");
  await messageService.reply(req.user, req.params.id, str(req.body.content) ?? "");
  res.json({ success: true, message: "✅ Reply sent!" });
}

// ---------- admin mailbox ----------

/** GET /api/messages/admin/list */
export async function adminList(_req: Request, res: Response): Promise<void> {
  res.json(await messageService.adminList());
}

/** POST /api/messages/admin/reply/:id — {content}. */
export async function adminReply(req: Request, res: Response): Promise<void> {
  if (!req.user) throw new Error("LOGIN_REQUIRED");
  await messageService.adminReply(req.user, req.params.id, str(req.body.content) ?? "");
  res.json({ success: true, message: "✅ Reply sent to user!" });
}
