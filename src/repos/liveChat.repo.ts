import { get, all, run } from "../db/query.js";
import { randomId } from "../utils/errors.js";
import type { LiveSessionRow, LiveMessageRow } from "../types.js";

/**
 * Live Messaging (support chat) — session_key model (guests supported).
 * Message ids exposed to clients are the numeric rowid (the original client
 * dedupes with `m.id <= lastId`, which only works with monotonically numeric
 * ids).
 */
export interface LiveMessageOut extends LiveMessageRow {
  rowid: number;
}

export const liveChatRepo = {
  // ---------- sessions ----------

  async findByKey(sessionKey: string): Promise<LiveSessionRow | null> {
    return get<LiveSessionRow>(`SELECT * FROM live_sessions WHERE session_key = ?`, [sessionKey]);
  },

  async create(sessionKey: string, userId: string | null, visitorName: string): Promise<LiveSessionRow> {
    const row: LiveSessionRow = {
      id: randomId(),
      session_key: sessionKey,
      user_id: userId,
      visitor_name: visitorName,
      last_message: null,
      last_message_at: new Date().toISOString(),
      unread_admin: 0,
      unread_visitor: 0,
      is_open: 1,
      created_at: new Date().toISOString(),
    };
    await run(
      `INSERT INTO live_sessions (id, session_key, user_id, visitor_name, last_message, last_message_at, unread_admin, unread_visitor, is_open)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.session_key, row.user_id, row.visitor_name, row.last_message, row.last_message_at, 0, 0, 1],
    );
    return row;
  },

  async updateVisitorName(sessionKey: string, name: string): Promise<void> {
    await run(`UPDATE live_sessions SET visitor_name = ? WHERE session_key = ?`, [name, sessionKey]);
  },

  async lastActivity(sessionKey: string, preview: string): Promise<void> {
    await run(
      `UPDATE live_sessions SET last_message = ?, last_message_at = datetime('now') WHERE session_key = ?`,
      [preview.slice(0, 140), sessionKey],
    );
  },

  async bumpUnread(sessionKey: string, side: "admin" | "visitor"): Promise<void> {
    const col = side === "admin" ? "unread_admin" : "unread_visitor";
    await run(`UPDATE live_sessions SET ${col} = ${col} + 1 WHERE session_key = ?`, [sessionKey]);
  },

  async resetUnread(sessionKey: string, side: "admin" | "visitor"): Promise<void> {
    const col = side === "admin" ? "unread_admin" : "unread_visitor";
    await run(`UPDATE live_sessions SET ${col} = 0 WHERE session_key = ?`, [sessionKey]);
  },

  async setOpen(sessionKey: string, open: boolean): Promise<void> {
    await run(`UPDATE live_sessions SET is_open = ? WHERE session_key = ?`, [open ? 1 : 0, sessionKey]);
  },

  /** All sessions, newest activity first (admin inbox). */
  async openSessions(limit = 50): Promise<LiveSessionRow[]> {
    return all<LiveSessionRow>(
      `SELECT * FROM live_sessions ORDER BY last_message_at DESC, created_at DESC LIMIT ?`,
      [limit],
    );
  },

  async unreadAdminTotal(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COALESCE(SUM(unread_admin), 0) AS n FROM live_sessions`);
    return row?.n ?? 0;
  },

  // ---------- messages (rowid-cursor) ----------

  async add(sessionKey: string, senderType: "visitor" | "admin", senderName: string | null, body: string): Promise<LiveMessageOut> {
    const id = randomId();
    await run(
      `INSERT INTO live_messages (id, session_key, sender_type, sender_name, body, is_read) VALUES (?, ?, ?, ?, ?, 0)`,
      [id, sessionKey, senderType, senderName, body],
    );
    const row = await get<LiveMessageOut>(
      `SELECT *, rowid AS rowid FROM live_messages WHERE id = ?`,
      [id],
    );
    return row!;
  },

  /** Messages with rowid > cursor. */
  async since(sessionKey: string, afterRowid: number | null, limit = 200): Promise<LiveMessageOut[]> {
    if (afterRowid) {
      return all<LiveMessageOut>(
        `SELECT *, rowid AS rowid FROM live_messages WHERE session_key = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?`,
        [sessionKey, afterRowid, limit],
      );
    }
    return all<LiveMessageOut>(
      `SELECT *, rowid AS rowid FROM live_messages WHERE session_key = ? ORDER BY rowid ASC LIMIT ?`,
      [sessionKey, limit],
    );
  },

  async markRead(sessionKey: string, side: "admin" | "visitor"): Promise<void> {
    const sender = side === "admin" ? "admin" : "visitor";
    await run(`UPDATE live_messages SET is_read = 1 WHERE session_key = ? AND sender_type = ?`, [sessionKey, sender]);
  },

  async lastRowid(sessionKey: string): Promise<number> {
    const row = await get<{ rowid: number }>(
      `SELECT MAX(rowid) AS rowid FROM live_messages WHERE session_key = ?`,
      [sessionKey],
    );
    return row?.rowid ?? 0;
  },

  /** Sessions whose last message changed after the given time (SSE polling). */
  async activitySince(sinceIso: string): Promise<{ key: string; at: string; preview: string }[]> {
    return all<{ key: string; at: string; preview: string }>(
      `SELECT session_key AS key, last_message_at AS at, COALESCE(last_message, '') AS preview
       FROM live_sessions WHERE last_message_at > ? ORDER BY last_message_at ASC`,
      [sinceIso],
    );
  },
};
