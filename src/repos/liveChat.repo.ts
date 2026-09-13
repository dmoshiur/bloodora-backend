import { get, all, run } from "../db/query.js";
import { randomId } from "../utils/errors.js";
import { nowIso, toEpochMs } from "../utils/time.js";
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
      `INSERT INTO live_sessions (id, session_key, user_id, visitor_name, last_message, last_message_at, unread_admin, unread_visitor, is_open, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.session_key, row.user_id, row.visitor_name, row.last_message, nowIso(), 0, 0, 1, nowIso()],
    );
    return row;
  },

  async updateVisitorName(sessionKey: string, name: string): Promise<void> {
    await run(`UPDATE live_sessions SET visitor_name = ? WHERE session_key = ?`, [name, sessionKey]);
  },

  /**
   * Stamp the session with the newest message. The timestamp is written as
   * ISO-8601 UTC (`nowIso()`), NOT `datetime('now')`: the admin SSE feed compares
   * this column against a JavaScript cursor, and the two formats never compare
   * correctly as strings (`'2026-09-13 06:49:18' > '2026-09-13T06:49:18Z'` is
   * always false), which silently froze the admin live-chat stream.
   */
  async lastActivity(sessionKey: string, preview: string): Promise<void> {
    await run(`UPDATE live_sessions SET last_message = ?, last_message_at = ? WHERE session_key = ?`, [
      preview.slice(0, 140),
      nowIso(),
      sessionKey,
    ]);
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

  /**
   * Append a message.
   *
   * When the client supplies `clientMessageId` the insert is idempotent: a
   * UNIQUE (session_key, client_message_id) index rejects the retry, and the
   * already-stored row is returned instead. A duplicated HTTP request, a
   * reconnect that replays a send, or a double-clicked button therefore can
   * never produce a second bubble in the database — which is the only kind of
   * duplicate a server can actually prevent.
   *
   * Returns `{ row, duplicate }` so the caller can tell the client what happened.
   */
  async add(
    sessionKey: string,
    senderType: "visitor" | "admin",
    senderName: string | null,
    body: string,
    clientMessageId?: string | null,
  ): Promise<{ row: LiveMessageOut; duplicate: boolean }> {
    const clientId = clientMessageId && clientMessageId.trim() ? clientMessageId.trim().slice(0, 120) : null;

    if (clientId) {
      const existing = await this.findByClientId(sessionKey, clientId);
      if (existing) return { row: existing, duplicate: true };
    }

    const id = randomId();
    try {
      await run(
        `INSERT INTO live_messages (id, session_key, sender_type, sender_name, body, is_read, client_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
        [id, sessionKey, senderType, senderName, body, clientId, nowIso()],
      );
    } catch (err) {
      // UNIQUE(session_key, client_message_id) — a concurrent retry won the race.
      // Reconcile to the stored row instead of surfacing a 500.
      const conflict = err as { code?: number; message?: string };
      const isUnique = conflict?.code === 1901 || /UNIQUE/i.test(conflict?.message || "");
      if (clientId && isUnique) {
        const winner = await this.findByClientId(sessionKey, clientId);
        if (winner) return { row: winner, duplicate: true };
      }
      throw err;
    }
    const row = await get<LiveMessageOut>(`SELECT *, rowid AS rowid FROM live_messages WHERE id = ?`, [id]);
    return { row: row!, duplicate: false };
  },

  async findByClientId(sessionKey: string, clientMessageId: string): Promise<LiveMessageOut | null> {
    return get<LiveMessageOut>(
      `SELECT *, rowid AS rowid FROM live_messages WHERE session_key = ? AND client_message_id = ? LIMIT 1`,
      [sessionKey, clientMessageId],
    );
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

  /**
   * Sessions whose last message changed after the given cursor (SSE polling).
   *
   * The comparison happens in JavaScript on normalized epoch values, not in SQL
   * on raw strings: rows written by older deployments store
   * `2026-09-13 06:49:18` while the SSE cursor is
   * `2026-09-13T06:49:18.894Z`, and a string comparison between the two formats
   * is always false (space sorts before 'T'). That is why the admin stream used
   * to emit nothing at all.
   */
  async activitySince(sinceIso: string | number): Promise<{ key: string; at: string; preview: string }[]> {
    const rows = await all<{ key: string; at: string; preview: string }>(
      `SELECT session_key AS key, last_message_at AS at, COALESCE(last_message, '') AS preview
       FROM live_sessions ORDER BY rowid DESC LIMIT 500`,
    );
    const cursor = toEpochMs(sinceIso);
    return rows
      .filter((r) => toEpochMs(r.at) > cursor)
      .sort((a, b) => toEpochMs(a.at) - toEpochMs(b.at));
  },
};
