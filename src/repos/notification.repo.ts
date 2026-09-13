import { all, get, run } from "../db/query.js";
import { nowIso } from "../utils/time.js";
import { randomId } from "../utils/errors.js";

/**
 * Notification store.
 *
 * `user_id` holds a real user id, or the sentinel `ADMINS` for the admin desk
 * (the same convention `messages.recipient_id = 'admin'` already uses). Read
 * state for a desk notification is shared by the admin team, which is what an
 * "unread support items" badge wants.
 *
 * Creation is idempotent through `dedupe_key`: a UNIQUE (user_id, dedupe_key)
 * index plus `ON CONFLICT DO NOTHING` means a retried request, a double-clicked
 * admin action or a re-delivered event can never produce a second bell entry.
 * Callers that legitimately want repeats pass a random dedupe key.
 */

export const ADMIN_DESK = "admins";

export interface NotificationRow {
  id: string;
  user_id: string;
  audience: "user" | "admin" | "system";
  type: string;
  level: string;
  title: string;
  body: string | null;
  lang: string;
  entity_type: string | null;
  entity_id: string | null;
  link: string | null;
  dedupe_key: string;
  is_read: number;
  read_at: string | null;
  created_at: string;
}

export interface NewNotification {
  userId: string;
  audience?: "user" | "admin" | "system";
  type: string;
  level?: "info" | "success" | "warning" | "danger";
  title: string;
  body?: string | null;
  lang?: string;
  entityType?: string | null;
  entityId?: string | null;
  link?: string | null;
  dedupeKey?: string | null;
}

export const notificationRepo = {
  /** Insert one notification. Returns the row, or null when it was a duplicate. */
  async create(n: NewNotification): Promise<NotificationRow | null> {
    const id = randomId();
    const dedupeKey = n.dedupeKey && n.dedupeKey.trim() ? n.dedupeKey.trim().slice(0, 190) : `rnd:${id}`;
    const createdAt = nowIso();
    const { changes } = await run(
      `INSERT INTO notifications
         (id, user_id, audience, type, level, title, body, lang, entity_type, entity_id, link, dedupe_key, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(user_id, dedupe_key) DO NOTHING`,
      [
        id,
        n.userId,
        n.audience ?? "user",
        n.type,
        n.level ?? "info",
        n.title.slice(0, 200),
        n.body ? String(n.body).slice(0, 1000) : null,
        n.lang ?? "en",
        n.entityType ?? null,
        n.entityId ?? null,
        n.link ?? null,
        dedupeKey,
        createdAt,
      ],
    );
    if (changes === 0) return null; // already delivered — idempotent no-op
    return this.findById(id);
  },

  async findById(id: string): Promise<NotificationRow | null> {
    return get<NotificationRow>(`SELECT * FROM notifications WHERE id = ?`, [id]);
  },

  async listFor(userId: string, opts: { unreadOnly?: boolean; limit?: number; offset?: number } = {}): Promise<NotificationRow[]> {
    const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
    const offset = Math.max(0, opts.offset ?? 0);
    const where = opts.unreadOnly ? `user_id = ? AND is_read = 0` : `user_id = ?`;
    return all<NotificationRow>(
      `SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      [userId, limit, offset],
    );
  },

  async unreadCount(userId: string): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0`, [userId]);
    return row?.n ?? 0;
  },

  async countByType(userId: string): Promise<{ type: string; n: number }[]> {
    return all<{ type: string; n: number }>(
      `SELECT type, COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0 GROUP BY type`,
      [userId],
    );
  },

  /** Mark one notification read — only if it belongs to this recipient. */
  async markRead(userId: string, id: string): Promise<boolean> {
    const { changes } = await run(
      `UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ? AND user_id = ? AND is_read = 0`,
      [nowIso(), id, userId],
    );
    return changes > 0;
  },

  async markAllRead(userId: string): Promise<number> {
    const { changes } = await run(`UPDATE notifications SET is_read = 1, read_at = ? WHERE user_id = ? AND is_read = 0`, [
      nowIso(),
      userId,
    ]);
    return changes;
  },

  async remove(userId: string, id: string): Promise<boolean> {
    const { changes } = await run(`DELETE FROM notifications WHERE id = ? AND user_id = ?`, [id, userId]);
    return changes > 0;
  },

  // ---- multi-recipient variants -------------------------------------------
  // An admin sees their own notifications AND the shared admin desk
  // (`user_id = 'admins'`). Those methods take the resolved recipient set so the
  // merge happens in one query instead of two round-trips plus a client-side sort.

  async listForMany(userIds: string[], opts: { unreadOnly?: boolean; limit?: number; offset?: number } = {}): Promise<NotificationRow[]> {
    if (userIds.length === 0) return [];
    const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
    const offset = Math.max(0, opts.offset ?? 0);
    const ph = userIds.map(() => "?").join(",");
    const where = opts.unreadOnly ? `user_id IN (${ph}) AND is_read = 0` : `user_id IN (${ph})`;
    return all<NotificationRow>(
      `SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      [...userIds, limit, offset],
    );
  },

  async unreadCountForMany(userIds: string[]): Promise<number> {
    if (userIds.length === 0) return 0;
    const ph = userIds.map(() => "?").join(",");
    const row = await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM notifications WHERE user_id IN (${ph}) AND is_read = 0`,
      userIds,
    );
    return row?.n ?? 0;
  },

  async countByTypeForMany(userIds: string[]): Promise<{ type: string; n: number }[]> {
    if (userIds.length === 0) return [];
    const ph = userIds.map(() => "?").join(",");
    return all<{ type: string; n: number }>(
      `SELECT type, COUNT(*) AS n FROM notifications WHERE user_id IN (${ph}) AND is_read = 0 GROUP BY type ORDER BY n DESC`,
      userIds,
    );
  },

  /**
   * Mark read / delete within the caller's recipient set.
   *
   * The desk row is shared: one admin clearing it clears it for the team, which
   * is the point of a shared desk — an alert nobody has to look at twice.
   */
  async markReadForMany(userIds: string[], id: string): Promise<boolean> {
    if (userIds.length === 0) return false;
    const ph = userIds.map(() => "?").join(",");
    const { changes } = await run(
      `UPDATE notifications SET is_read = 1, read_at = ? WHERE id = ? AND user_id IN (${ph}) AND is_read = 0`,
      [nowIso(), id, ...userIds],
    );
    return changes > 0;
  },

  async markAllReadForMany(userIds: string[]): Promise<number> {
    if (userIds.length === 0) return 0;
    const ph = userIds.map(() => "?").join(",");
    const { changes } = await run(
      `UPDATE notifications SET is_read = 1, read_at = ? WHERE user_id IN (${ph}) AND is_read = 0`,
      [nowIso(), ...userIds],
    );
    return changes;
  },

  async removeForMany(userIds: string[], id: string): Promise<boolean> {
    if (userIds.length === 0) return false;
    const ph = userIds.map(() => "?").join(",");
    const { changes } = await run(`DELETE FROM notifications WHERE id = ? AND user_id IN (${ph})`, [id, ...userIds]);
    return changes > 0;
  },

  async total(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications`);
    return row?.n ?? 0;
  },

  async countCreatedAfter(sinceIso: string): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE created_at >= ?`, [sinceIso]);
    return row?.n ?? 0;
  },

  /** Retention: keep the newest `keep` rows per recipient is overkill; prune globally. */
  async prune(keep = 5000): Promise<number> {
    const { changes } = await run(
      `DELETE FROM notifications WHERE rowid NOT IN (SELECT rowid FROM notifications ORDER BY rowid DESC LIMIT ?)`,
      [keep],
    );
    return changes;
  },
};
