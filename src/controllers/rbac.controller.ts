import type { Request, Response } from "express";
import { rbacService } from "../services/rbac.service.js";
import { auditRepo } from "../repos/audit.repo.js";
import { PERMISSIONS, ROLES } from "../data/permissions.js";
import { clampInt, str } from "../utils/validate.js";
import { ApiError } from "../utils/errors.js";
import type { SafeUser } from "../types.js";

/**
 * Role & permission administration + the audit trail.
 *
 * Routes decide WHO may call these (`users.role.assign`, `system.audit.view`);
 * the service decides whether the change itself is legal (no self-lockout, no
 * deleting a role still assigned to accounts, no touching a super admin unless
 * you are one). Both layers audit the attempt, including denials.
 */

function actor(req: Request): SafeUser {
  if (!req.user) throw ApiError.unauthorized();
  return req.user;
}

function ctx(req: Request): { ip: string | null; userAgent: string | null } {
  const xff = req.headers["x-forwarded-for"];
  const ip = typeof xff === "string" && xff.trim() ? xff.split(",")[0].trim() : req.ip || null;
  return { ip, userAgent: str(req.headers["user-agent"]) ?? null };
}

/** GET /api/rbac/me — the caller's effective role + permissions. */
export async function me(req: Request, res: Response): Promise<void> {
  const user = actor(req);
  const eff = await rbacService.effective(user);
  res.json({
    success: true,
    role: eff.role,
    permissions: eff.permissions,
    is_admin: eff.isAdmin,
    is_super_admin: eff.isSuperAdmin,
  });
}

/** GET /api/admin/roles */
export async function listRoles(req: Request, res: Response): Promise<void> {
  actor(req);
  const roles = await rbacService.listRoles();
  res.json({ success: true, roles, total: roles.length, system_roles: ROLES.map((r) => r.key) });
}

/** GET /api/admin/roles/:key */
export async function getRole(req: Request, res: Response): Promise<void> {
  actor(req);
  res.json({ success: true, role: await rbacService.getRole(req.params.key) });
}

/** POST /api/admin/roles */
export async function createRole(req: Request, res: Response): Promise<void> {
  res.json(await rbacService.createRole(actor(req), req.body as Record<string, unknown>, ctx(req)));
}

/** PUT /api/admin/roles/:key */
export async function updateRole(req: Request, res: Response): Promise<void> {
  res.json(await rbacService.updateRole(actor(req), req.params.key, req.body as Record<string, unknown>, ctx(req)));
}

/** DELETE /api/admin/roles/:key */
export async function deleteRole(req: Request, res: Response): Promise<void> {
  res.json(await rbacService.deleteRole(actor(req), req.params.key, ctx(req)));
}

/**
 * GET /api/admin/permissions — the permission catalogue.
 *
 * Served from the database when it has been seeded (so a custom permission
 * created at runtime shows up), with the built-in definitions as the fallback
 * and as the source of human-readable names/groups for the seeded keys.
 */
export async function listPermissions(req: Request, res: Response): Promise<void> {
  actor(req);
  const known = new Map(PERMISSIONS.map((p) => [p.key, p]));
  // `permissions.group_name` is nullable, so grouping falls back to the built-in
  // definition and finally to "other" — a custom permission created at runtime
  // still appears in the panel instead of vanishing from an unknown group.
  let rows: { key: string; name?: string | null; group_name?: string | null; description?: string | null; roles?: string[] }[] = [];
  try {
    rows = await rbacService.listPermissions();
  } catch {
    rows = [];
  }
  const merged = (rows.length ? rows : PERMISSIONS.map((p) => ({ key: p.key, name: p.name, group_name: p.group, description: p.description, roles: [] as string[] }))).map((r) => {
    const def = known.get(r.key);
    return {
      key: r.key,
      name: def?.name ?? r.name ?? r.key,
      group: r.group_name ?? def?.group ?? "other",
      description: def?.description ?? r.description ?? "",
      roles: r.roles ?? [],
    };
  });
  const groups = [...new Set(merged.map((m) => m.group))].sort();
  res.json({ success: true, permissions: merged, total: merged.length, groups });
}

/** POST /api/admin/users/:id/role — assign a role key. */
export async function assignRole(req: Request, res: Response): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const role = str(body.role) || str(body.role_key);
  if (!role) throw ApiError.badRequest("A `role` key is required.", "ROLE_REQUIRED");
  res.json(await rbacService.assignRole(actor(req), req.params.id, role, ctx(req)));
}

function parseMeta(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Audit meta is freeform; an unreadable blob must not break the log view.
    return raw;
  }
}

/** GET /api/admin/audit — filterable audit trail. */
export async function audit(req: Request, res: Response): Promise<void> {
  actor(req);
  const filters = {
    actorId: str(req.query.actor_id) ?? str(req.query.actor) ?? undefined,
    action: str(req.query.action) ?? undefined,
    entityType: str(req.query.entity_type) ?? undefined,
    entityId: str(req.query.entity_id) ?? undefined,
  };
  const limit = clampInt(req.query.limit, 50, 1, 200);
  const offset = clampInt(req.query.offset, 0, 0, 100000);
  const [rows, total, actions] = await Promise.all([
    auditRepo.list({ ...filters, limit, offset }),
    auditRepo.count({ actorId: filters.actorId, action: filters.action }),
    auditRepo.distinctActions(),
  ]);
  res.json({
    success: true,
    entries: rows.map((r) => ({
      id: r.id,
      actor_id: r.actor_id,
      actor_role: r.actor_role,
      action: r.action,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      summary: r.summary,
      meta: parseMeta(r.meta),
      ip: r.ip,
      created_at: r.created_at,
    })),
    total,
    limit,
    offset,
    actions,
  });
}
