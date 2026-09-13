import type { Request, Response } from "express";
import { navigationService } from "../services/navigation.service.js";
import { toBool, str } from "../utils/validate.js";
import { ApiError } from "../utils/errors.js";
import type { SafeUser } from "../types.js";

/**
 * Site navigation.
 *
 * `GET /api/meta/routes` keeps its historical shape (the page catalogue the AI
 * and the sitemap consume). `GET /api/meta/nav` is the menu-oriented view:
 * public / user / admin areas, already filtered by who is asking, so a client
 * never has to decide on its own whether a link should be rendered.
 */

function actor(req: Request): SafeUser {
  if (!req.user) throw ApiError.unauthorized();
  return req.user;
}

function ctx(req: Request): { ip: string | null } {
  const xff = req.headers["x-forwarded-for"];
  return { ip: typeof xff === "string" && xff.trim() ? xff.split(",")[0].trim() : req.ip || null };
}

/** GET /api/meta/nav — areas filtered for the caller (anonymous allowed). */
export async function nav(req: Request, res: Response): Promise<void> {
  const config = await navigationService.navConfig();
  const authed = Boolean(req.user);
  const isAdmin = authed && (req.user!.role !== "user" || Boolean(req.user!.is_admin));
  res.json({
    success: true,
    public: config.public,
    user: authed ? config.user : [],
    admin: isAdmin ? config.admin : [],
    authenticated: authed,
    is_admin: isAdmin,
  });
}

/** GET /api/admin/navigation */
export async function adminList(req: Request, res: Response): Promise<void> {
  actor(req);
  res.json(await navigationService.list(str(req.query.area)));
}

/** POST /api/admin/navigation */
export async function adminCreate(req: Request, res: Response): Promise<void> {
  res.json(await navigationService.create(actor(req), req.body as Record<string, unknown>, ctx(req)));
}

/** PUT /api/admin/navigation/:id */
export async function adminUpdate(req: Request, res: Response): Promise<void> {
  res.json(await navigationService.update(actor(req), req.params.id, req.body as Record<string, unknown>, ctx(req)));
}

/** DELETE /api/admin/navigation/:id */
export async function adminRemove(req: Request, res: Response): Promise<void> {
  res.json(await navigationService.remove(actor(req), req.params.id, ctx(req)));
}

/**
 * POST /api/admin/navigation/:id/toggle — show/hide without deleting.
 * The admin panel posts HTML checkboxes: present means "on", absent means
 * untouched, so `active` is only honoured when the caller actually sent it.
 */
export async function adminToggle(req: Request, res: Response): Promise<void> {
  const user = actor(req);
  const body = req.body as Record<string, unknown>;
  if (body.active === undefined && body.is_active === undefined) {
    throw ApiError.badRequest("An `active` flag is required.", "ACTIVE_REQUIRED");
  }
  const active = toBool(body.active !== undefined ? body.active : body.is_active);
  res.json(await navigationService.setActive(user, req.params.id, active, ctx(req)));
}

/** POST /api/admin/navigation/reorder — {order: [id, ...]} */
export async function adminReorder(req: Request, res: Response): Promise<void> {
  const user = actor(req);
  const body = req.body as Record<string, unknown>;
  res.json(await navigationService.reorder(user, body.order ?? body.ids, ctx(req)));
}

/** POST /api/admin/navigation/seed — restore the built-in catalogue if empty. */
export async function adminSeed(req: Request, res: Response): Promise<void> {
  actor(req);
  const inserted = await navigationService.ensureSeeded();
  res.json({
    success: true,
    inserted,
    message: inserted > 0 ? `✅ Seeded ${inserted} navigation entries.` : "ℹ️ Navigation is already populated.",
  });
}
