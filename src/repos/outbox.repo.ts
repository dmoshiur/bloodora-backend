import { all, get, run } from "../db/query.js";
import { nowIso } from "../utils/time.js";
import { randomId } from "../utils/errors.js";

/**
 * Durable mail outbox.
 *
 * A serverless function can be frozen the moment it responds, so "fire and
 * forget" email is unreliable: the send may never run. Every message is
 * therefore written to the outbox FIRST and then attempted inline; the row is
 * marked `sent` on success and left `pending`/`failed` otherwise, so the next
 * request (or the maintenance cron) can deliver it.
 *
 * That also gives the admin panel a truthful delivery queue instead of a log
 * that only records what happened to succeed.
 */

export interface OutboxRow {
  id: string;
  to_email: string;
  subject: string;
  html: string;
  text: string | null;
  attempts: number;
  status: "pending" | "sent" | "failed";
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
}

export const MAX_ATTEMPTS = 5;

export const outboxRepo = {
  async enqueue(input: { to: string; subject: string; html: string; text?: string | null }): Promise<string> {
    const id = randomId();
    await run(
      `INSERT INTO email_outbox (id, to_email, subject, html, text, attempts, status, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 'pending', ?)`,
      [id, input.to, input.subject.slice(0, 300), input.html, input.text ?? null, nowIso()],
    );
    return id;
  },

  async claimNext(limit = 10): Promise<OutboxRow[]> {
    return all<OutboxRow>(
      `SELECT * FROM email_outbox WHERE status != 'sent' AND attempts < ? ORDER BY created_at ASC LIMIT ?`,
      [MAX_ATTEMPTS, Math.min(50, Math.max(1, limit))],
    );
  },

  async markSent(id: string): Promise<void> {
    await run(`UPDATE email_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?`, [
      nowIso(),
      id,
    ]);
  },

  async markFailed(id: string, error: string): Promise<void> {
    await run(
      `UPDATE email_outbox SET attempts = attempts + 1, last_error = ?,
              status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END
        WHERE id = ?`,
      [String(error).slice(0, 400), MAX_ATTEMPTS, id],
    );
  },

  /**
   * Most recent outbox rows for the admin mail view.
   *
   * Bodies are capped at 4000 characters — enough to read a message and to find
   * the action link inside it (a reset token sits well past 200 chars), while
   * still bounding the response when a template is large.
   */
  async recent(limit = 25, status?: string | null): Promise<OutboxRow[]> {
    const n = Math.min(100, Math.max(1, limit));
    if (status) {
      return all<OutboxRow>(
        `SELECT id, to_email, subject, substr(html, 1, 4000) AS html, text, attempts, status, last_error, created_at, sent_at
         FROM email_outbox WHERE status = ? ORDER BY rowid DESC LIMIT ?`,
        [status, n],
      );
    }
    return all<OutboxRow>(
      `SELECT id, to_email, subject, substr(html, 1, 4000) AS html, text, attempts, status, last_error, created_at, sent_at
       FROM email_outbox ORDER BY rowid DESC LIMIT ?`,
      [n],
    );
  },

  async counts(): Promise<{ pending: number; sent: number; failed: number }> {
    const row = await get<{ pending: number; sent: number; failed: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS sent,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
       FROM email_outbox`,
    );
    return { pending: row?.pending ?? 0, sent: row?.sent ?? 0, failed: row?.failed ?? 0 };
  },

  /** Retention: drop delivered rows beyond the newest `keep`. */
  async prune(keep = 2000): Promise<number> {
    const { changes } = await run(
      `DELETE FROM email_outbox WHERE status = 'sent'
         AND rowid NOT IN (SELECT rowid FROM email_outbox WHERE status = 'sent' ORDER BY rowid DESC LIMIT ?)`,
      [keep],
    );
    return changes;
  },
};
