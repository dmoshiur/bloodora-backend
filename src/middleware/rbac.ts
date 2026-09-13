import type { Request, Response, NextFunction } from "express";
import { rbacService } from "../services/rbac.service.js";
import { authService } from "../services/auth.service.js";
import { bearer } from "./auth.js";
import type { SafeUser } from "../types.js";

/**
 * Permission middleware.
 *
 * `requireAdmin` / `requireSuperAdmin` answer "is this an admin?" — a single bit
 * that had to be re-derived by hand at every new endpoint, and that could not
 * express "an admin who may issue refunds but must not delete users".
 *
 * These guards answer "may this caller do THIS?" against the `role_permissions`
 * table. Two properties matter:
 *
 *   - the role is re-read from the database on every request, so a token minted
 *     before a privilege was revoked stops working immediately (no re-login);
 *   - a denial writes an audit row, so an attempted privilege escalation is
 *     visible in Admin → Audit instead of disappearing into a 403.
 *
 * The legacy `is_admin` / `is_super_admin` flags still drive `requireAdmin` and
 * keep working; the seeded roles grant them the same abilities, so an existing
 * admin sees no change.
 */

/** Resolve `req.user` from the session cookie or bearer token when upstream auth did not. */
async function ensureUser(req: Request): Promise<SafeUser | null> {
  if (req.user) return req.user;
  const user = await authService.resolveUser(
    req as unknown as { session?: Record<string, unknown> | null },
    bearer(req),
  );
  if (!user) return null;
  req.user = user;
  return user;
}

function unauthorized(next: NextFunction): void {
  next(Object.assign(new Error("Authentication required"), { status: 401, code: "UNAUTHENTICATED" }));
}

function clientIp(req: Request): string | null {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) return xff.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || null;
}

/** Require EVERY listed permission (e.g. `requirePermission("payments.refund")`). */
export function requirePermission(...permissions: string[]) {
  return async function permissionGuard(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await ensureUser(req);
      if (!user) {
        unauthorized(next);
        return;
      }
      await rbacService.require(user, permissions, { ip: clientIp(req) });
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Require AT LEAST ONE of the listed permissions. */
export function requireAnyPermission(...permissions: string[]) {
  return async function anyPermissionGuard(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await ensureUser(req);
      if (!user) {
        unauthorized(next);
        return;
      }
      const eff = await rbacService.effective(user);
      // requireAny() writes the denial audit row and throws the 403 itself.
      if (!permissions.some((p) => eff.permissions.includes(p))) {
        await rbacService.requireAny(user, permissions, { ip: clientIp(req) });
        return;
      }
      req.userRoleKey = eff.role;
      req.userPermissions = eff.permissions;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Attach the caller's effective role + permissions to the response body of the
 * next handler's payload — used by `/api/auth/me` so the frontend can render
 * menu items it is actually allowed to show.
 */
export async function attachCapabilities(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await ensureUser(req);
    if (!user) {
      next();
      return;
    }
    const eff = await rbacService.effective(user);
    req.userRoleKey = eff.role;
    req.userPermissions = eff.permissions;
    next();
  } catch {
    // Capabilities are cosmetic: never fail a request because they could not be
    // resolved — an empty list just hides the extra UI.
    req.userRoleKey = req.user?.role ?? "user";
    req.userPermissions = [];
    next();
  }
}
