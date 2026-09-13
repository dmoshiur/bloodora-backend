import type { InStatement, InValue, ResultSet, Transaction, TransactionMode } from "@libsql/client";
import { getClient } from "./client.js";
import { logger } from "../utils/logger.js";
import { withTimeout } from "./timeout.js";
import { dbBreaker } from "./breaker.js";
import { config } from "../config/env.js";

function cleanArgs(args: unknown[]): InValue[] {
  return args.map((a): InValue => {
    if (a === undefined || a === null) return null;
    if (a instanceof Uint8Array) return a;
    if (a instanceof Date) return a;
    return a as InValue;
  });
}

function stmt(sql: string, args: unknown[] = []): InStatement {
  return { sql, args: cleanArgs(args) };
}

/**
 * One database operation, guarded.
 *
 * This is the choke point every repo, service and middleware goes through, so it
 * is where the three cross-cutting database behaviours live — and why they cannot
 * be forgotten by a new caller:
 *
 *   1. **the breaker gate** — while Turso is known to be down, do not even start
 *      the call; answer the shaped 503 in ~1 ms instead of spending `ms` (see
 *      `src/db/breaker.ts` for the measurement that motivated it);
 *   2. **the deadline** — `withTimeout`, clamped to whatever is left of the
 *      current invocation;
 *   3. **the classification** — a transport failure becomes a 503
 *      `DB_UNAVAILABLE` with a safe message; a SQL error passes through untouched
 *      so `SQLITE_CONSTRAINT_UNIQUE` still means `EMAIL_TAKEN` (409) and a real
 *      bug still means 500 with its stack in the log.
 *
 * `start` is a thunk rather than a promise so the gate is checked BEFORE the
 * operation is created: `getClient()` itself can throw (a production instance
 * with no `TURSO_DATABASE_URL`), and that throw must be classified too.
 */
async function guarded<T>(label: string, start: () => Promise<T>, ms = config.dbTimeoutMs, probe = false): Promise<T> {
  if (!dbBreaker.allow(probe)) throw dbBreaker.refuse(label);
  try {
    const out = await withTimeout(start(), ms, label);
    dbBreaker.noteSuccess(label);
    return out;
  } catch (err) {
    throw dbBreaker.noteFailure(err, label);
  }
}

/**
 * A read that always reaches the database, even while the breaker is open.
 *
 * Only `GET /api/health` may use this: the endpoint whose job is to report the
 * state of the database must never be told the answer by a cache of our own
 * pessimism, and its success is what closes the breaker again. Everything else
 * goes through the gate.
 */
export async function probeQuery<T = Record<string, unknown>>(sql: string, args: unknown[] = [], ms = config.dbTimeoutMs): Promise<T | null> {
  const result: ResultSet = await guarded("health database probe", () => getClient().execute(stmt(sql, args)), ms, true);
  return (result.rows[0] as unknown as T) ?? null;
}

/** Run a query. libSQL 0.15: execute takes { sql, args }. */
export async function all<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> {
  const result: ResultSet = await guarded("SQL query", () => getClient().execute(stmt(sql, args)));
  return result.rows as unknown as T[];
}

/** Run a query, returning the first row or null. */
export async function get<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T | null> {
  const rows = await all<T>(sql, args);
  return rows[0] ?? null;
}

/** Run a mutating query (INSERT/UPDATE/DELETE/DDL). */
export async function run(sql: string, args: unknown[] = []): Promise<{ changes: number; lastInsertRowid: number }> {
  const result: ResultSet = await guarded("SQL statement", () => getClient().execute(stmt(sql, args)));
  return {
    changes: Number(result.rowsAffected ?? 0),
    lastInsertRowid: result.lastInsertRowid !== undefined ? Number(result.lastInsertRowid) : 0,
  };
}

/**
 * Execute many statements in **one** round trip.
 *
 * This is the single most important performance primitive in a serverless
 * deployment of this app: against a remote Turso database every `execute()` is a
 * separate HTTPS request, so the cold-start bootstrap used to cost 451 of them
 * (~18 s at a 50 ms RTT, ~70 s at 120 ms) — far past the platform's function
 * maxDuration, which is why the first request was killed and the API never
 * became reachable. `batch()` collapses a whole group into one request.
 *
 * Statements run in a transaction (`mode` defaults to libSQL's "deferred"), so a
 * group either fully applies or not at all — which is what the idempotent DDL and
 * seed steps want anyway.
 */
export async function batch(
  statements: Array<InStatement | string | [string, unknown[]?]>,
  mode: TransactionMode = "deferred",
): Promise<ResultSet[]> {
  const normalized: InStatement[] = statements.map((s) => {
    if (typeof s === "string") return stmt(s);
    if (Array.isArray(s)) return stmt(s[0], s[1] ?? []);
    return { sql: s.sql, args: cleanArgs((s.args as unknown[]) ?? []) };
  });
  if (normalized.length === 0) return [];
  const results = await guarded(
    `SQL batch (${normalized.length} statements)`,
    () => getClient().batch(normalized, mode),
    config.dbBatchTimeoutMs,
  );
  return results;
}

/** Convenience: `batch()` where only the affected-row counts matter. */
export async function batchRun(
  statements: Array<InStatement | string | [string, unknown[]?]>,
  mode: TransactionMode = "deferred",
): Promise<{ changes: number; count: number }> {
  const results = await batch(statements, mode);
  return {
    changes: results.reduce((sum, r) => sum + Number(r.rowsAffected ?? 0), 0),
    count: results.length,
  };
}

export interface TxExecutor {
  run(sql: string, args?: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
  get<T>(sql: string, args?: unknown[]): Promise<T | null>;
  all<T>(sql: string, args?: unknown[]): Promise<T[]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * Run `fn` inside a single interactive transaction (libSQL 0.15:
 * `client.transaction("write")` → Promise<Transaction>). On error the
 * transaction is rolled back and the original error re-thrown.
 *
 * Every step — including `commit()` and the error-path `rollback()` — carries a
 * deadline, so a transaction can never be the thing that leaves a request
 * pending forever.
 */
export async function transaction<T>(fn: (tx: TxExecutor) => Promise<T>): Promise<T> {
  const tx: Transaction = await guarded("open transaction", () => getClient().transaction("write"));
  const executor: TxExecutor = {
    async run(sql: string, args: unknown[] = []) {
      const r = (await guarded("tx statement", () => tx.execute(stmt(sql, args)))) as ResultSet;
      return {
        changes: Number(r.rowsAffected ?? 0),
        lastInsertRowid: r.lastInsertRowid !== undefined ? Number(r.lastInsertRowid) : 0,
      };
    },
    async get<T2>(sql: string, args: unknown[] = []) {
      const r = (await guarded("tx query", () => tx.execute(stmt(sql, args)))) as ResultSet;
      return (r.rows[0] as unknown as T2) ?? null;
    },
    async all<T2>(sql: string, args: unknown[] = []) {
      const r = (await guarded("tx query", () => tx.execute(stmt(sql, args)))) as ResultSet;
      return r.rows as unknown as T2[];
    },
    async commit() {
      await guarded("commit transaction", () => tx.commit());
    },
    async rollback() {
      try {
        await guarded("rollback transaction", () => tx.rollback());
      } catch (e) {
        logger.warn("transaction rollback failed", { err: String(e) });
      }
    },
  };
  try {
    const out = await fn(executor);
    await executor.commit();
    return out;
  } catch (err) {
    await executor.rollback();
    throw err;
  }
}
