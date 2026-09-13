import type { Request, Response, NextFunction } from "express";
import { authService } from "../services/auth.service.js";
import { applyUserLanguage } from "./language.js";
import type { SafeUser } from "../types.js";

declare module "express" {
  interface Request {
    user?: SafeUser;
    isAdminClaim?: boolean;
    /** Effective role key resolved from the database by the RBAC guards. */
    userRoleKey?: string;
    /** Effective permission keys resolved from the database by the RBAC guards. */
    userPermissions?: string[];
  }
}

// Session contract: the auth JWT lives in the persistent session under `jwt`
// (express-session's documented declaration-merging pattern).
declare module "express-session" {
  interface SessionData {
    jwt?: string;
  }
}

export function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (h && h.toLowerCase().startsWith("bearer ")) {
    const t = h.slice(7).trim();
    return t.length > 0 ? t : undefined;
  }
  return undefined;
}

/**
 * Resolve the current user from EITHER the httpOnly session cookie handle
 * (express-session stores a JWT under session.jwt for the frontend's document
 * cookies) OR an `Authorization: Bearer` header (mobile/API clients).
 *
 * The token's sid claim is re-checked against users.session_token on every
 * request, so logout revokes all tokens immediately.
 */
export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await authService.resolveUser(req as unknown as { session?: Record<string, unknown> | null }, bearer(req));
    if (!user) {
      next(Object.assign(new Error("Authentication required"), { status: 401, code: "UNAUTHENTICATED" }));
      return;
    }
    req.user = user;
    req.isAdminClaim = user.role !== "user";
    // A signed-in caller's saved preference outranks Accept-Language but never
    // an explicit ?lang=/body.lang (that is how the frontend switcher works).
    applyUserLanguage(req, user.language);
    next();
  } catch (err) {
    next(err);
  }
}

/** Attach the user when present, but allow anonymous through (e.g. profile page). */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await authService.resolveUser(req as unknown as { session?: Record<string, unknown> | null }, bearer(req));
    if (user) {
      req.user = user;
      req.isAdminClaim = user.role !== "user";
      applyUserLanguage(req, user.language);
    }
    next();
  } catch (err) {
    next(err);
  }
}
