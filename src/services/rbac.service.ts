import { roleRepo, type PermissionRow, type RoleRow } from "../repos/role.repo.js";
import { userRepo } from "../repos/user.repo.js";
import { auditRepo } from "../repos/audit.repo.js";
import { notificationService } from "./notification.service.js";
import { PERMISSION_KEYS, ROLES, SYSTEM_ROLE_KEYS, isKnownPermission } from "../data/permissions.js";
import { ApiError, randomId } from "../utils/errors.js";
import { str } from "../utils/validate.js";
import { logger } from "../utils/logger.js";
import type { SafeUser } from "../types.js";

/**
 * Role & permission service — the backend is the final authority.
 *
 * `users.role` remains the single source of truth for *which* role an account
 * has (the existing contract, the admin dashboard and the EJS views all read
 * `is_admin` / `is_super_admin` / `role`). This service resolves *what that role
 * may do* from the database on every privileged request, so:
 *
 *   - a JWT claim is never sufficient (the token says `adm:true`; the DB decides);
 *   - revoking a permission takes effect on the next request, not the next login;
 *   - the frontend can render the truth by reading `permissions` from
 *     `GET /api/auth/me` instead of guessing from a role name.
 *
 * Resolution is cached in-process for a few seconds only. That cache is a
 * latency optimization, not state: the authoritative read is one indexed query
 * against `role_permissions`, and any write through this service invalidates the
 * local cache immediately.
 */

const CACHE_TTL_MS = 5_000;
const permissionCache = new Map<string, { keys: Set<string>; at: number }>();

export function invalidatePermissionCache(): void {
  permissionCache.clear();
}

export const rbacService = {
  /** Called from the DB bootstrap; safe to run on every cold start. */
  async seed(): Promise<void> {
    const out = await roleRepo.seedCatalogue();
    if (out.roles > 0 || out.granted > 0) {
      logger.info("rbac: catalogue seeded", out);
    }
    invalidatePermissionCache();
  },

  /** Effective permission keys for a role (DB-backed, 5 s cache). */
  async permissionsForRole(roleKey: string | null | undefined): Promise<string[]> {
    const key = roleKey || "user";
    const hit = permissionCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return [...hit.keys];
    const keys = new Set(await roleRepo.permissionsForRole(key));
    // A missing/unseeded role row must never lock an admin out of the panel:
    // built-in roles fall back to their coded definition (defence against a
    // half-applied migration), while custom roles simply have no permissions.
    if (keys.size === 0) {
      const fallback = ROLES.find((r) => r.key === key);
      if (fallback) for (const p of fallback.permissions) keys.add(p);
    }
    permissionCache.set(key, { keys, at: Date.now() });
    return [...keys];
  },

  /**
   * Resolve the caller's effective permissions from the DATABASE. `safeUser` is
   * only used for its id — the role is re-read so a stale token cannot carry a
   * revoked privilege.
   */
  async effective(safeUser: SafeUser): Promise<{ role: string; permissions: string[]; isAdmin: boolean; isSuperAdmin: boolean }> {
    const row = await userRepo.findById(safeUser.id);
    let role = row?.role ?? "user";
    // Legacy/edge rows can carry the boolean flags without a matching role key
    // (an account written before `role` was populated, or a hand-edited row).
    // Honour the flags rather than silently locking an existing admin out: the
    // fallback maps to the seeded role that grants the same abilities.
    if (row && (role === "user" || !role)) {
      if (row.is_super_admin === 1) role = "super_admin";
      else if (row.is_admin === 1) role = "admin";
    }
    const permissions = await this.permissionsForRole(role);
    return {
      role,
      permissions,
      isAdmin: Boolean(row?.is_admin) || role !== "user",
      isSuperAdmin: Boolean(row?.is_super_admin) || role === "super_admin",
    };
  },

  async can(safeUser: SafeUser, permission: string): Promise<boolean> {
    const { permissions } = await this.effective(safeUser);
    return permissions.includes(permission);
  },

  /** Throw unless the caller holds every listed permission. */
  async require(safeUser: SafeUser, permissions: string[], ctx: { ip?: string | null } = {}): Promise<void> {
    const eff = await this.effective(safeUser);
    const missing = permissions.filter((p) => !eff.permissions.includes(p));
    if (missing.length > 0) {
      await auditRepo
        .create({
          actorId: safeUser.id,
          actorRole: eff.role,
          action: "permission.denied",
          summary: `Denied: ${missing.join(", ")}`,
          ip: ctx.ip ?? null,
        })
        .catch(() => {});
      throw ApiError.forbidden(`Missing permission: ${missing.join(", ")}`, "PERMISSION_DENIED");
    }
  },

  /** Throw unless the caller holds AT LEAST ONE of the listed permissions. */
  async requireAny(safeUser: SafeUser, permissions: string[], ctx: { ip?: string | null } = {}): Promise<void> {
    const eff = await this.effective(safeUser);
    if (permissions.some((p) => eff.permissions.includes(p))) return;
    await auditRepo
      .create({
        actorId: safeUser.id,
        actorRole: eff.role,
        action: "permission.denied",
        summary: `Denied: any of ${permissions.join(", ")}`,
        ip: ctx.ip ?? null,
      })
      .catch(() => {});
    throw ApiError.forbidden(`Missing permission: ${permissions.join(" | ")}`, "PERMISSION_DENIED");
  },

  // ------------------------------- reads -------------------------------

  async listRoles(): Promise<
    { id: string; key: string; name: string; description: string | null; level: number; is_system: boolean; permissions: string[]; users: number }[]
  > {
    const roles = await roleRepo.listRoles();
    return Promise.all(
      roles.map(async (r: RoleRow) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        description: r.description,
        level: r.level,
        is_system: Boolean(r.is_system),
        permissions: await roleRepo.permissionsForRole(r.key),
        users: await roleRepo.countUsersWithRole(r.key),
      })),
    );
  },

  async listPermissions(): Promise<(PermissionRow & { roles: string[] })[]> {
    const rows = await roleRepo.listPermissions();
    return Promise.all(rows.map(async (p) => ({ ...p, roles: await roleRepo.rolesForPermission(p.key) })));
  },

  async getRole(key: string) {
    const role = await roleRepo.getRole(key);
    if (!role) throw ApiError.notFound("Role not found", "ROLE_NOT_FOUND");
    return { ...role, is_system: Boolean(role.is_system), permissions: await roleRepo.permissionsForRole(key) };
  },

  // ------------------------------- writes -------------------------------

  async createRole(
    actor: SafeUser,
    body: Record<string, unknown>,
    ctx: { ip?: string | null; userAgent?: string | null } = {},
  ) {
    const key = (str(body.key) || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40);
    const name = str(body.name) || key;
    if (!key) throw ApiError.badRequest("A role key is required (a-z, 0-9, _).", "ROLE_KEY_REQUIRED");
    if (SYSTEM_ROLE_KEYS.includes(key)) throw ApiError.conflict("That role key is reserved.", "ROLE_KEY_RESERVED");
    if (await roleRepo.getRole(key)) throw ApiError.conflict("A role with that key already exists.", "ROLE_EXISTS");
    const permissions = normalizePermissionList(body.permissions);
    await roleRepo.createRole({ key, name, description: str(body.description) ?? null, level: Number(body.level) || 1, isSystem: false });
    if (permissions.length) await roleRepo.replaceRolePermissions(key, permissions);
    invalidatePermissionCache();
    await audit(actor, "role.create", "role", key, `Created role ${key}`, { permissions }, ctx);
    return { success: true, message: `✅ Role “${name}” created.`, role: await this.getRole(key) };
  },

  async updateRole(
    actor: SafeUser,
    key: string,
    body: Record<string, unknown>,
    ctx: { ip?: string | null; userAgent?: string | null } = {},
  ) {
    const role = await roleRepo.getRole(key);
    if (!role) throw ApiError.notFound("Role not found", "ROLE_NOT_FOUND");
    const before = await roleRepo.permissionsForRole(key);
    const fields: { name?: string; description?: string | null; level?: number } = {};
    if (str(body.name)) fields.name = str(body.name);
    if (body.description !== undefined) fields.description = str(body.description) ?? null;
    if (body.level !== undefined) fields.level = Math.max(0, Math.min(99, Number(body.level) || 0));
    if (Object.keys(fields).length) await roleRepo.updateRole(key, fields);

    if (body.permissions !== undefined) {
      const next = normalizePermissionList(body.permissions);
      // Guard: an admin may not strip the permission they are currently relying
      // on from their OWN role — that is how accounts lock themselves out of the
      // panel with no way back in.
      const actorRole = (await userRepo.findById(actor.id))?.role ?? "user";
      if (actorRole === key) {
        const eff = await this.effective(actor);
        const lost = eff.permissions.filter((p) => !next.includes(p));
        if (lost.length) {
          throw ApiError.badRequest(
            `You cannot remove permissions from the role you are using (${lost.join(", ")}). Ask another super admin.`,
            "SELF_LOCKOUT",
          );
        }
      }
      await roleRepo.replaceRolePermissions(key, next);
      invalidatePermissionCache();
      await audit(actor, "role.permissions.update", "role", key, `Permissions changed for ${key}`, { before, after: next }, ctx);
    } else if (Object.keys(fields).length) {
      await audit(actor, "role.update", "role", key, `Role ${key} updated`, fields, ctx);
    }
    return { success: true, message: `✅ Role “${key}” updated.`, role: await this.getRole(key) };
  },

  async deleteRole(actor: SafeUser, key: string, ctx: { ip?: string | null; userAgent?: string | null } = {}) {
    const role = await roleRepo.getRole(key);
    if (!role) throw ApiError.notFound("Role not found", "ROLE_NOT_FOUND");
    if (role.is_system === 1 || SYSTEM_ROLE_KEYS.includes(key)) {
      throw ApiError.badRequest("Built-in roles cannot be deleted.", "SYSTEM_ROLE");
    }
    const users = await roleRepo.countUsersWithRole(key);
    if (users > 0) {
      throw ApiError.conflict(`${users} account(s) still have this role — reassign them first.`, "ROLE_IN_USE");
    }
    await roleRepo.deleteRole(key);
    invalidatePermissionCache();
    await audit(actor, "role.delete", "role", key, `Deleted role ${key}`, null, ctx);
    return { success: true, message: `✅ Role “${key}” deleted.` };
  },

  /** Assign a role to an account (super admin only — enforced by the route). */
  async assignRole(
    actor: SafeUser,
    userId: string,
    roleKey: string,
    ctx: { ip?: string | null; userAgent?: string | null } = {},
  ) {
    const role = await roleRepo.getRole(roleKey);
    if (!role) throw ApiError.notFound("Role not found", "ROLE_NOT_FOUND");
    const target = await userRepo.findById(userId);
    if (!target) throw ApiError.notFound("User not found", "USER_NOT_FOUND");
    if (target.id === actor.id && role.level < ((await roleRepo.getRole(actor.role || "user"))?.level ?? 9)) {
      throw ApiError.badRequest("You cannot downgrade your own account.", "SELF_DEMOTE");
    }
    if (target.is_super_admin === 1 && roleKey !== "super_admin" && actor.role !== "super_admin") {
      throw ApiError.forbidden("Only a super admin may change another super admin.", "SUPER_ADMIN_ONLY");
    }

    const before = target.role;
    const isSuper = roleKey === "super_admin";
    const isAdmin = roleKey !== "user";
    await userRepo.setSuperAdmin(userId, isSuper, isAdmin || isSuper);
    await userRepo.setRole(userId, roleKey, isAdmin || isSuper);
    // A role change must take effect immediately: rotate the session token so
    // every previously issued JWT is re-validated against the new role.
    await userRepo.setSessionToken(userId, randomId(24));
    invalidatePermissionCache();

    await audit(actor, "user.role.assign", "user", userId, `${target.name}: ${before} → ${roleKey}`, { before, after: roleKey }, ctx);
    notificationService.emitAsync({
      event: "admin_user_role",
      userIds: [userId],
      params: {},
      title: `Your role is now ${role.name}`,
      entityType: "user",
      entityId: userId,
      dedupeKey: `role:${roleKey}`,
      link: "/donors/profile/my",
    });
    const fresh = await userRepo.findById(userId);
    return {
      success: true,
      message: `✅ ${target.name} is now ${role.name}.`,
      user: fresh
        ? {
            id: fresh.id,
            name: fresh.name,
            email: fresh.email,
            role: fresh.role,
            account_role: fresh.role,
            is_admin: Boolean(fresh.is_admin),
            is_super_admin: Boolean(fresh.is_super_admin),
            permissions: await this.permissionsForRole(fresh.role),
          }
        : null,
    };
  },
};

function normalizePermissionList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out = raw.map((v) => String(v).trim()).filter(Boolean);
  const known = out.filter((k) => isKnownPermission(k) || PERMISSION_KEYS.includes(k));
  const unknown = out.filter((k) => !known.includes(k));
  if (unknown.length) {
    throw ApiError.badRequest(`Unknown permission(s): ${unknown.join(", ")}`, "UNKNOWN_PERMISSION");
  }
  return [...new Set(known)];
}

async function audit(
  actor: SafeUser,
  action: string,
  entityType: string,
  entityId: string,
  summary: string,
  meta: Record<string, unknown> | null,
  ctx: { ip?: string | null; userAgent?: string | null },
): Promise<void> {
  await auditRepo
    .create({
      actorId: actor.id,
      actorRole: actor.role || null,
      action,
      entityType,
      entityId,
      summary,
      meta,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    })
    .catch((err) => logger.warn("rbac: audit write failed", { err: String(err) }));
}

