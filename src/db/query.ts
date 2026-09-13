import type { InStatement, InValue, ResultSet, Transaction } from "@libsql/client";
import { getClient } from "./client.js";
import { logger } from "../utils/logger.js";

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

/** Run a query. libSQL 0.15: execute takes { sql, args }. */
export async function all<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T[]> {
  const result: ResultSet = await getClient().execute(stmt(sql, args));
  return result.rows as unknown as T[];
}

/** Run a query, returning the first row or null. */
export async function get<T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T | null> {
  const rows = await all<T>(sql, args);
  return rows[0] ?? null;
}

/** Run a mutating query (INSERT/UPDATE/DELETE/DDL). */
export async function run(sql: string, args: unknown[] = []): Promise<{ changes: number; lastInsertRowid: number }> {
  const result: ResultSet = await getClient().execute(stmt(sql, args));
  return {
    changes: Number(result.rowsAffected ?? 0),
    lastInsertRowid: result.lastInsertRowid !== undefined ? Number(result.lastInsertRowid) : 0,
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
 */
export async function transaction<T>(fn: (tx: TxExecutor) => Promise<T>): Promise<T> {
  const tx: Transaction = await getClient().transaction("write");
  const executor: TxExecutor = {
    async run(sql: string, args: unknown[] = []) {
      const r = (await tx.execute(stmt(sql, args))) as ResultSet;
      return {
        changes: Number(r.rowsAffected ?? 0),
        lastInsertRowid: r.lastInsertRowid !== undefined ? Number(r.lastInsertRowid) : 0,
      };
    },
    async get<T2>(sql: string, args: unknown[] = []) {
      const r = (await tx.execute(stmt(sql, args))) as ResultSet;
      return (r.rows[0] as unknown as T2) ?? null;
    },
    async all<T2>(sql: string, args: unknown[] = []) {
      const r = (await tx.execute(stmt(sql, args))) as ResultSet;
      return r.rows as unknown as T2[];
    },
    async commit() {
      await tx.commit();
    },
    async rollback() {
      try {
        await tx.rollback();
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
