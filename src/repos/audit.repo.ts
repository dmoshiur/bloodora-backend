import { all, get, run } from "../db/query.js";
import { nowIso } from "../utils/time.js";
import { randomId } from "../utils/errors.js";
import { redact } from "../utils/logger.js";

/**
 * Audit trail for privileged actions.
 *
 * Written for admin/security events: role and permission changes, user
 * edits/deletes, content CRUD, settings/SMTP/AI configuration, payment and
 * order status changes, impersonation, logins and failed logins.
 *
 * Metadata goes through the logger's `redact()` on the way in, so a body that
 * happens to contain `password`, `token`, `secret`, `api_key` or `cookie` is
 * stored as `[REDACTED]` — an audit log must never become a credential store.
 */

export interface AuditRow {
  id: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  summary: string | null;
  meta: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface AuditInput {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  summary?: string | null;
  meta?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
}

export const auditRepo = {
  async create(entry: AuditInput): Promise<string> {
    const id = randomId();
    const safeMeta = entry.meta ? JSON.stringify(redact(entry.meta, 0)) : null;
    await run(
      `INSERT INTO audit_logs (id, actor_id, actor_role, action, entity_type, entity_id, summary, meta, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entry.actorId ?? null,
        entry.actorRole ?? null,
        entry.action.slice(0, 80),
        entry.entityType ?? null,
        entry.entityId ?? null,
        entry.summary ? String(entry.summary).slice(0, 300) : null,
        safeMeta && safeMeta.length > 8000 ? safeMeta.slice(0, 8000) : safeMeta,
        entry.ip ?? null,
        entry.userAgent ? String(entry.userAgent).slice(0, 200) : null,
        nowIso(),
      ],
    );
    return id;
  },

  async list(opts: { actorId?: string; action?: string; entityType?: string; entityId?: string; limit?: number; offset?: number } = {}): Promise<AuditRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.actorId) {
      where.push("actor_id = ?");
      args.push(opts.actorId);
    }
    if (opts.action) {
      where.push("action = ?");
      args.push(opts.action);
    }
    if (opts.entityType) {
      where.push("entity_type = ?");
      args.push(opts.entityType);
    }
    if (opts.entityId) {
      where.push("entity_id = ?");
      args.push(opts.entityId);
    }
    const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
    const offset = Math.max(0, opts.offset ?? 0);
    return all<AuditRow>(
      `SELECT * FROM audit_logs${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
  },

  async count(opts: { actorId?: string; action?: string } = {}): Promise<number> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.actorId) {
      where.push("actor_id = ?");
      args.push(opts.actorId);
    }
    if (opts.action) {
      where.push("action = ?");
      args.push(opts.action);
    }
    const row = await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_logs${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
      args,
    );
    return row?.n ?? 0;
  },

  async distinctActions(limit = 60): Promise<string[]> {
    const rows = await all<{ action: string }>(`SELECT DISTINCT action FROM audit_logs ORDER BY action ASC LIMIT ?`, [limit]);
    return rows.map((r) => r.action);
  },

  async prune(keep = 20000): Promise<number> {
    const { changes } = await run(
      `DELETE FROM audit_logs WHERE rowid NOT IN (SELECT rowid FROM audit_logs ORDER BY rowid DESC LIMIT ?)`,
      [keep],
    );
    return changes;
  },
};
