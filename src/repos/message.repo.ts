import { get, all, run } from "../db/query.js";
import { randomId } from "../utils/errors.js";
import type { MessageRow } from "../types.js";

/**
 * User↔admin messaging. recipient_id 'admin' addresses the site administrator;
 * replies thread via replied_to. is_admin_message marks admin-originated rows.
 */
export const messageRepo = {
  async create(
    senderId: string,
    recipientId: string,
    subject: string,
    body: string,
    opts: { isAdminMessage?: boolean; isAdminReply?: boolean; repliedTo?: string } = {},
  ): Promise<string> {
    const id = randomId();
    await run(
      `INSERT INTO messages (id, sender_id, recipient_id, subject, body, is_admin_message, is_admin_reply, replied_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, senderId, recipientId, subject, body,
        opts.isAdminMessage ? 1 : 0, opts.isAdminReply ? 1 : 0, opts.repliedTo ?? null,
      ],
    );
    return id;
  },

  async findById(id: string): Promise<MessageRow | null> {
    return get<MessageRow>(`SELECT * FROM messages WHERE id = ?`, [id]);
  },

  /** Messages the user RECEIVED (from admins), newest first. */
  async inbox(userId: string, limit = 50): Promise<MessageRow[]> {
    return all<MessageRow>(
      `SELECT * FROM messages WHERE recipient_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      [userId, limit],
    );
  },

  /** Messages the user SENT (originals, not their own replies to admins). */
  async sent(userId: string, limit = 50): Promise<MessageRow[]> {
    return all<MessageRow>(
      `SELECT * FROM messages WHERE sender_id = ? AND is_admin_reply = 0 ORDER BY created_at DESC, id DESC LIMIT ?`,
      [userId, limit],
    );
  },

  async unreadCount(userId: string): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND read_at IS NULL`, [userId]);
    return row?.n ?? 0;
  },

  /** Unread messages addressed to the site admin (original dashboard stat). */
  async unreadAdmin(): Promise<number> {
    const row = await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE recipient_id = 'admin' AND read_at IS NULL`,
    );
    return row?.n ?? 0;
  },

  async markRead(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const marks = ids.map(() => `?`).join(",");
    await run(
      `UPDATE messages SET read_at = datetime('now') WHERE id IN (${marks}) AND read_at IS NULL`,
      ids,
    );
  },

  async delete(id: string): Promise<void> {
    await run(`DELETE FROM messages WHERE id = ?`, [id]);
  },

  async countAll(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM messages`);
    return row?.n ?? 0;
  },

  // ---------- Admin side ----------

  /** All messages sent TO the site (recipient 'admin'), newest first. */
  async adminInbox(limit = 100): Promise<MessageRow[]> {
    return all<MessageRow>(
      `SELECT * FROM messages WHERE recipient_id = 'admin' AND is_admin_reply = 0
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [limit],
    );
  },

  async adminUnreadCount(): Promise<number> {
    const row = await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages WHERE recipient_id = 'admin' AND is_admin_reply = 0 AND read_at IS NULL`,
    );
    return row?.n ?? 0;
  },
};
