import { all, batch, get, run } from "../db/query.js";
import { nowIso } from "../utils/time.js";
import { randomId } from "../utils/errors.js";
import { PERMISSIONS, ROLES } from "../data/permissions.js";

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  level: number;
  is_system: number;
  /** JSON list of the grants the last deploy seeded (see seedCatalogue). */
  seeded_permissions: string | null;
  created_at: string;
}

export interface PermissionRow {
  id: string;
  key: string;
  name: string;
  group_name: string | null;
  description: string | null;
}

export const roleRepo = {
  // ---------- catalogue ----------

  async listRoles(): Promise<RoleRow[]> {
    return all<RoleRow>(`SELECT * FROM roles ORDER BY level ASC, key ASC`);
  },

  async getRole(key: string): Promise<RoleRow | null> {
    return get<RoleRow>(`SELECT * FROM roles WHERE key = ?`, [key]);
  },

  async listPermissions(): Promise<PermissionRow[]> {
    return all<PermissionRow>(`SELECT * FROM permissions ORDER BY group_name ASC, key ASC`);
  },

  async permissionsForRole(key: string): Promise<string[]> {
    const rows = await all<{ permission_key: string }>(`SELECT permission_key FROM role_permissions WHERE role_key = ?`, [key]);
    return rows.map((r) => r.permission_key);
  },

  async rolesForPermission(permissionKey: string): Promise<string[]> {
    const rows = await all<{ role_key: string }>(`SELECT role_key FROM role_permissions WHERE permission_key = ?`, [permissionKey]);
    return rows.map((r) => r.role_key);
  },

  async countUsersWithRole(key: string): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE role = ?`, [key]);
    return row?.n ?? 0;
  },

  // ---------- writes ----------

  async createRole(input: { key: string; name: string; description?: string | null; level?: number; isSystem?: boolean }): Promise<RoleRow> {
    const id = randomId();
    await run(
      `INSERT INTO roles (id, key, name, description, level, is_system, seeded_permissions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.key, input.name, input.description ?? null, input.level ?? 1, input.isSystem ? 1 : 0, null, nowIso()],
    );
    return (await this.getRole(input.key))!;
  },

  async updateRole(key: string, fields: { name?: string; description?: string | null; level?: number }): Promise<void> {
    await run(
      `UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description), level = COALESCE(?, level) WHERE key = ?`,
      [fields.name ?? null, fields.description ?? null, fields.level ?? null, key],
    );
  },

  async setSeededPermissions(key: string, permissionKeys: string[]): Promise<void> {
    await run(`UPDATE roles SET seeded_permissions = ? WHERE key = ?`, [JSON.stringify(permissionKeys), key]);
  },

  async deleteRole(key: string): Promise<void> {
    await run(`DELETE FROM role_permissions WHERE role_key = ?`, [key]);
    await run(`DELETE FROM roles WHERE key = ?`, [key]);
  },

  async replaceRolePermissions(key: string, permissionKeys: string[]): Promise<void> {
    await run(`DELETE FROM role_permissions WHERE role_key = ?`, [key]);
    for (const p of new Set(permissionKeys)) {
      await run(`INSERT INTO role_permissions (role_key, permission_key) VALUES (?, ?) ON CONFLICT DO NOTHING`, [key, p]);
    }
  },

  async grantPermission(key: string, permissionKey: string): Promise<void> {
    await run(`INSERT INTO role_permissions (role_key, permission_key) VALUES (?, ?) ON CONFLICT DO NOTHING`, [key, permissionKey]);
  },

  async revokePermission(key: string, permissionKey: string): Promise<void> {
    await run(`DELETE FROM role_permissions WHERE role_key = ? AND permission_key = ?`, [key, permissionKey]);
  },

  /**
   * Idempotent seed.
   *
   * Permissions are upserted from code (the catalogue is the authority for
   * names/descriptions). Roles are inserted once. Grants are then reconciled
   * against the *previously seeded* grant list, kept on the role row itself
   * (`roles.seeded_permissions`):
   *
   *   - a permission that is new in this deploy → granted (roles keep working
   *     after a feature is added);
   *   - a permission an admin deliberately revoked → stays revoked.
   *
   * Without that record the two cases are indistinguishable, and "backfill
   * everything the catalogue lists" would silently undo an admin's decision on
   * every deploy.
   */
  /**
   * Seed/reconcile the role + permission catalogue in THREE round trips
   * (upsert permissions → read current state → write the delta), regardless of
   * catalogue size.
   *
   * The previous implementation issued one statement per permission, per role,
   * per existing grant lookup and per individual grant — ~116 sequential HTTPS
   * requests to Turso on every cold start. That alone could exceed a serverless
   * function's maxDuration, so the first request was killed before it could
   * answer and the API never became reachable.
   *
   * Semantics are unchanged: display metadata always follows the catalogue, while
   * grants are only ever ADDED for keys a previous deploy seeded and an admin has
   * not since revoked (`seeded_permissions` is the record of what we last wrote).
   */
  async seedCatalogue(): Promise<{ roles: number; permissions: number; granted: number }> {
    // (1) Permission definitions follow the code; one request upserts them all.
    await batch(
      PERMISSIONS.map(
        (p) =>
          [
            `INSERT INTO permissions (id, key, name, group_name, description) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET name = excluded.name, group_name = excluded.group_name, description = excluded.description`,
            [randomId(), p.key, p.name, p.group, p.description],
          ] as [string, unknown[]],
      ),
    );

    // (2) Read every existing role and every current grant in one request.
    const read = await batch([`SELECT * FROM roles`, `SELECT role_key, permission_key FROM role_permissions`]);
    const existingRoles = new Map<string, RoleRow>();
    for (const r of (read[0]?.rows ?? []) as unknown as RoleRow[]) existingRoles.set(r.key, r);
    const currentGrants = new Map<string, Set<string>>();
    for (const g of (read[1]?.rows ?? []) as unknown as Array<{ role_key: string; permission_key: string }>) {
      const set = currentGrants.get(g.role_key) ?? new Set<string>();
      set.add(g.permission_key);
      currentGrants.set(g.role_key, set);
    }

    // (3) Compute the delta, then apply all of it in a single request.
    const writes: Array<[string, unknown[]]> = [];
    let roles = 0;
    let granted = 0;

    const grantStmt = `INSERT INTO role_permissions (role_key, permission_key) VALUES (?, ?) ON CONFLICT DO NOTHING`;

    for (const r of ROLES) {
      const existing = existingRoles.get(r.key);
      const wanted = [...new Set(r.permissions)];

      if (!existing) {
        writes.push([
          `INSERT INTO roles (id, key, name, description, level, is_system, seeded_permissions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [randomId(), r.key, r.name, r.description ?? null, r.level ?? 1, 1, JSON.stringify(wanted), nowIso()],
        ]);
        for (const p of wanted) {
          writes.push([grantStmt, [r.key, p]]);
          granted += 1;
        }
        roles += 1;
        continue;
      }

      // Display metadata follows the catalogue; grants do not.
      writes.push([
        `UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description), level = COALESCE(?, level) WHERE key = ?`,
        [r.name, r.description ?? null, r.level ?? null, r.key],
      ]);

      let previouslySeeded: string[] = [];
      try {
        previouslySeeded = JSON.parse(existing.seeded_permissions || "[]") as string[];
      } catch {
        previouslySeeded = [];
      }
      const current = currentGrants.get(r.key) ?? new Set<string>();

      if (current.size === 0 && previouslySeeded.length === 0) {
        // First seed against a pre-existing role row (or a wiped grant table).
        writes.push([`DELETE FROM role_permissions WHERE role_key = ?`, [r.key]]);
        for (const p of wanted) {
          writes.push([grantStmt, [r.key, p]]);
          granted += 1;
        }
      } else {
        // Only keys this deploy newly added, and only where not already granted:
        // an admin's revocation of an older key stays revoked.
        for (const p of wanted.filter((k) => !previouslySeeded.includes(k))) {
          if (!current.has(p)) {
            writes.push([grantStmt, [r.key, p]]);
            granted += 1;
          }
        }
      }

      writes.push([`UPDATE roles SET seeded_permissions = ? WHERE key = ?`, [JSON.stringify(wanted), r.key]]);
    }

    if (writes.length > 0) await batch(writes);
    return { roles, permissions: PERMISSIONS.length, granted };
  }
,
};
