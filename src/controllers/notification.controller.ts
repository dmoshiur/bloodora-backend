import type { Request, Response } from "express";
import { notificationService } from "../services/notification.service.js";
import { clampInt, toBool } from "../utils/validate.js";
import { ApiError } from "../utils/errors.js";

/**
 * In-app notifications.
 *
 * Every endpoint is scoped to the caller: `notificationService.recipientsFor()`
 * resolves "my rows, plus the shared admin desk when my account role is admin".
 * No user id is ever taken from the request body or query — a caller cannot ask
 * for somebody else's feed.
 */

/** GET /api/notifications — feed + unread counters. */
export async function list(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const notifications = await notificationService.feed(req.user, {
    unreadOnly: toBool(req.query.unread),
    limit: clampInt(req.query.limit, 25, 1, 100),
    offset: clampInt(req.query.offset, 0, 0, 10000),
  });
  res.json(notifications);
}

/** GET /api/notifications/unread — badge count only (polled cheaply). */
export async function unread(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const summary = await notificationService.summaryFor(req.user);
  res.json({ success: true, unread: summary.unread, by_type: summary.byType });
}

/** POST /api/notifications/:id/read */
export async function markRead(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const ok = await notificationService.readOne(req.user, req.params.id);
  if (!ok) throw ApiError.notFound("Notification not found.", "NOTIFICATION_NOT_FOUND");
  res.json({ success: true, message: "Marked as read." });
}

/** POST /api/notifications/read-all */
export async function markAllRead(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const updated = await notificationService.readAll(req.user);
  res.json({ success: true, updated, message: `✅ ${updated} notification(s) marked as read.` });
}

/** DELETE /api/notifications/:id */
export async function remove(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const ok = await notificationService.removeOne(req.user, req.params.id);
  if (!ok) throw ApiError.notFound("Notification not found.", "NOTIFICATION_NOT_FOUND");
  res.json({ success: true, message: "Notification removed." });
}
