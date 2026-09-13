import type { Request, Response, NextFunction } from "express";
import { authService } from "../services/auth.service.js";
import { bearer } from "./auth.js";
import { applyUserLanguage } from "./language.js";
import type { SafeUser } from "../types.js";

/**
 * Enforce admin (or super admin) access. Re-checks the role from the database
 * on every request — the JWT claim alone is never trusted for authorization.
 *
 * Self-contained on purpose: if `req.user` was not attached by an upstream
 * `requireAuth`, the user is resolved here from the session cookie / bearer
 * token, so routers may use `requireAdmin` on its own without a 401 loop.
 */
async function ensureUser(req: Request): Promise<SafeUser | null> {
  if (req.user) return req.user;
  const user = await authService.resolveUser(req as unknown as { session?: Record<string, unknown> | null }, bearer(req));
  if (!user) return null;
  req.user = user;
  req.isAdminClaim = user.role !== "user";
  applyUserLanguage(req, user.language);
  return user;
}

function unauthorized(next: NextFunction): void {
  next(Object.assign(new Error("Authentication required"), { status: 401, code: "UNAUTHENTICATED" }));
}

export async function requireAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await ensureUser(req);
    if (!user) {
      unauthorized(next);
      return;
    }
    req.user = await authService.requireAdmin(user.id, Boolean(req.isAdminClaim));
    next();
  } catch (err) {
    next(err);
  }
}

export async function requireSuperAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await ensureUser(req);
    if (!user) {
      unauthorized(next);
      return;
    }
    req.user = await authService.requireSuperAdmin(user.id);
    next();
  } catch (err) {
    next(err);
  }
}

export type { SafeUser };
