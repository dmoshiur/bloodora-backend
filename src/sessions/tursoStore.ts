import { Store, type SessionData } from "express-session";
import { get, run } from "../db/query.js";

interface SessionRow {
  sid: string;
  data: string;
  expires_at: number;
}

/**
 * Production-safe session store backed by the `sessions` table (Turso/libSQL).
 * Works across multiple serverless instances because every read/write goes to
 * the shared database — nothing is kept in process memory.
 *
 * Extends express-session's Store so createSession/regenerate/load exist and
 * the store is a valid EventEmitter for express-session's internal handling.
 */
export class TursoSessionStore extends Store {
  async get(sid: string, cb: (err: Error | null, session?: SessionData | null) => void): Promise<void> {
    try {
      const now = Date.now();
      const row = await get<SessionRow>(
        `SELECT sid, data, expires_at FROM sessions WHERE sid = ? AND expires_at > ?`,
        [sid, now],
      );
      if (!row) {
        cb(null, undefined);
        return;
      }
      try {
        cb(null, JSON.parse(row.data) as SessionData);
      } catch {
        cb(null, undefined);
      }
    } catch (err) {
      cb(err as Error);
    }
  }

  async set(sid: string, session: SessionData, cb: (err?: Error | null) => void): Promise<void> {
    try {
      const expires = session.cookie?.expires;
      const expiresAt =
        expires instanceof Date ? expires.getTime() : Date.now() + 7 * 24 * 3600 * 1000;
      await run(
        `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
        [sid, JSON.stringify(session), expiresAt],
      );
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  async destroy(sid: string, cb: (err?: Error | null) => void): Promise<void> {
    try {
      await run(`DELETE FROM sessions WHERE sid = ?`, [sid]);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  async clearExpired(cb: (err?: Error | null) => void): Promise<void> {
    try {
      const { changes } = await run(`DELETE FROM sessions WHERE expires_at <= ?`, [Date.now()]);
      if (changes > 0) {
        console.log(`[sessions] purged ${changes} expired rows`);
      }
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }

  async touch(sid: string, session: SessionData, cb: (err?: Error | null) => void): Promise<void> {
    try {
      const expires = session.cookie?.expires;
      const expiresAt =
        expires instanceof Date ? expires.getTime() : Date.now() + 7 * 24 * 3600 * 1000;
      await run(`UPDATE sessions SET expires_at = ? WHERE sid = ?`, [expiresAt, sid]);
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}
