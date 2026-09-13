import { Store, type SessionData } from "express-session";
import { get, run } from "../db/query.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { withTimeout } from "../db/timeout.js";

interface SessionRow {
  sid: string;
  data: string;
  expires_at: number;
}

/**
 * Production-safe session store backed by the `sessions` table (Turso/libSQL).
 * Works across multiple serverless instances because every read/write goes to
 * the shared database — nothing is kept in process memory, so there is no
 * MemoryStore and no `connect.session() MemoryStore is not designed for a
 * production environment` warning.
 *
 * EVERY operation is bounded by `SESSION_TIMEOUT_MS` (default 3 s), because
 * express-session runs *before* the router on every request that carries a
 * `connect.sid` cookie. An unbounded store read was therefore able to hang even
 * `GET /api/health`: the browser sends the cookie, express-session calls
 * `store.get()`, `store.get()` awaits libSQL, and libSQL never times out.
 *
 * Failure behaviour is deliberately asymmetric:
 *   - reads fail OPEN  → `cb(null, undefined)`, i.e. "no session". The caller is
 *     treated as logged out and a protected route answers 401 in milliseconds.
 *     Never a hang, never a 500 on a public endpoint.
 *   - writes fail QUIETLY (logged) → the request still completes. A dropped
 *     session write shows up as a 401 on the *next* request, which is a
 *     controlled, diagnosable error rather than an infinite spinner.
 */
export class TursoSessionStore extends Store {
  /** Bound a store operation; `operation` is only used for the log line. */
  private bounded<T>(p: Promise<T>, operation: string): Promise<T> {
    return withTimeout(p, config.sessionTimeoutMs, `session ${operation}`, "SESSION_STORE_TIMEOUT");
  }

  async get(sid: string, cb: (err: Error | null, session?: SessionData | null) => void): Promise<void> {
    try {
      const now = Date.now();
      const row = await this.bounded(
        get<SessionRow>(`SELECT sid, data, expires_at FROM sessions WHERE sid = ? AND expires_at > ?`, [sid, now]),
        "read",
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
      // Fail open: an unavailable session store must log the caller out, not
      // stall the request. Passing the error to express-session here is what
      // used to turn a database blip into a 500 (or, before the timeout existed,
      // an endless hang) on every authenticated page.
      logger.warn("session store: read failed — continuing without a session", {
        err: String((err as Error)?.message ?? err),
      });
      cb(null, undefined);
    }
  }

  async set(sid: string, session: SessionData, cb: (err?: Error | null) => void): Promise<void> {
    try {
      const expires = session.cookie?.expires;
      const expiresAt = expires instanceof Date ? expires.getTime() : Date.now() + config.jwtTtlDays * 24 * 3600 * 1000;
      await this.bounded(
        run(
          `INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`,
          [sid, JSON.stringify(session), expiresAt],
        ),
        "write",
      );
      cb();
    } catch (err) {
      logger.error("session store: write failed — the next request will require a new login", {
        err: String((err as Error)?.message ?? err),
      });
      cb();
    }
  }

  async destroy(sid: string, cb: (err?: Error | null) => void): Promise<void> {
    try {
      await this.bounded(run(`DELETE FROM sessions WHERE sid = ?`, [sid]), "destroy");
    } catch (err) {
      logger.warn("session store: destroy failed", { err: String((err as Error)?.message ?? err) });
    }
    cb();
  }

  async clearExpired(cb: (err?: Error | null) => void): Promise<void> {
    try {
      const { changes } = await this.bounded(run(`DELETE FROM sessions WHERE expires_at <= ?`, [Date.now()]), "clearExpired");
      if (changes > 0) logger.info("session store: purged expired rows", { changes });
    } catch (err) {
      logger.warn("session store: clearExpired failed", { err: String((err as Error)?.message ?? err) });
    }
    cb();
  }

  async touch(sid: string, session: SessionData, cb: (err?: Error | null) => void): Promise<void> {
    try {
      const expires = session.cookie?.expires;
      const expiresAt = expires instanceof Date ? expires.getTime() : Date.now() + config.jwtTtlDays * 24 * 3600 * 1000;
      await this.bounded(run(`UPDATE sessions SET expires_at = ? WHERE sid = ?`, [expiresAt, sid]), "touch");
    } catch (err) {
      // A missed touch only shortens a session's life; it must never fail a request.
      logger.debug("session store: touch failed", { err: String((err as Error)?.message ?? err) });
    }
    cb();
  }
}
