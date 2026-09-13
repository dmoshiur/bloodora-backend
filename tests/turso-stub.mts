/**
 * A minimal **Hrana-over-HTTP (v2, JSON)** server backed by a local libSQL file.
 *
 * ============================== WHY THIS EXISTS =============================
 * Every other suite in this repository runs against `file:` libSQL — the local
 * driver. Production runs against **remote Turso over HTTPS**, which is a
 * completely different transport inside the same `@libsql/client` package:
 *
 *   - each `execute()` is one `POST /v2/pipeline` carrying
 *     `[{execute}, {close}]` (no persistent connection);
 *   - each `batch()` is one `POST /v2/pipeline` whose steps are
 *     `BEGIN → stmt… → COMMIT → ROLLBACK(not ok(commit))`;
 *   - an interactive `transaction()` spans SEVERAL requests, correlated by the
 *     `baton` the server hands back;
 *   - values cross the wire as tagged JSON (`{"type":"blob","base64":…}`,
 *     `{"type":"integer","value":"42"}`), so integers come back through
 *     `BigInt` and BLOBs come back as `ArrayBuffer`, not the shapes the local
 *     driver produces;
 *   - the ONLY network deadline available is the custom `fetch` injected into
 *     `createClient()` — `src/db/timeout.ts` → `timedFetch()`.
 *
 * So the transport that production actually uses, and the deadline that is
 * supposed to bound it, were both untested. This stub makes them testable:
 * point `TURSO_DATABASE_URL` at it and the app believes it is talking to Turso.
 *
 * It also lets a test do the two things a real cloud database will eventually do
 * to us and that no local file can simulate:
 *
 *   - `setLatency(ms)`  — every round trip takes that long (a cold start then
 *     costs N × RTT, which is the number that decides whether the bootstrap
 *     fits inside the platform's invocation budget);
 *   - `setFailure(mode)` — refuse connections, answer 5xx, or never answer at
 *     all, which is how an unreachable Turso host used to hang every request
 *     forever (`@libsql/client` implements no timeout of its own).
 *
 * Deliberately NOT a test: it is a harness, like `tests/serverless-harness.mts`.
 * ===========================================================================
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, type Client, type InStatement, type Transaction } from "@libsql/client";

// ---------------------------------------------------------------------------
// Wire types (Hrana v2 / JSON) — mirrors @libsql/hrana-client/lib-esm/http.
// ---------------------------------------------------------------------------

type HranaValue =
  | { type: "null" }
  | { type: "integer"; value: string }
  | { type: "float"; value: number }
  | { type: "text"; value: string }
  | { type: "blob"; base64: string };

interface HranaStmt {
  sql?: string;
  sql_id?: number;
  args?: HranaValue[];
  named_args?: Array<{ name: string; value: HranaValue }>;
  want_rows?: boolean;
}

type BatchCond =
  | { type: "ok"; step: number }
  | { type: "error"; step: number }
  | { type: "not"; cond: BatchCond }
  | { type: "and"; conds: BatchCond[] }
  | { type: "or"; conds: BatchCond[] }
  | { type: "is_autocommit" };

interface HranaBatchStep {
  condition?: BatchCond;
  stmt: HranaStmt;
}

type StreamRequest =
  | { type: "close" }
  | { type: "execute"; stmt: HranaStmt }
  | { type: "batch"; batch: { steps: HranaBatchStep[] } }
  | { type: "sequence"; sql?: string; sql_id?: number }
  | { type: "describe"; sql?: string; sql_id?: number }
  | { type: "store_sql"; sql_id: number; sql: string }
  | { type: "close_sql"; sql_id: number }
  | { type: "get_autocommit" };

interface PipelineReq {
  baton?: string;
  requests: StreamRequest[];
}

interface StmtResult {
  cols: Array<{ name: string | null; decltype?: string | null }>;
  rows: HranaValue[][];
  affected_row_count: number;
  last_insert_rowid?: string;
}

type StreamResult =
  | { type: "ok"; response: { type: "execute"; result: StmtResult } }
  | {
      type: "ok";
      response: {
        type: "batch";
        result: { step_results: Array<StmtResult | null>; step_errors: Array<{ message: string; code?: string } | null> };
      };
    }
  | { type: "ok"; response: { type: "close" } }
  | { type: "ok"; response: { type: "sequence" } }
  | { type: "ok"; response: { type: "store_sql" } }
  | { type: "ok"; response: { type: "close_sql" } }
  | { type: "ok"; response: { type: "describe"; result: { params: unknown[]; cols: unknown[]; is_explain: boolean; is_readonly: boolean } } }
  | { type: "ok"; response: { type: "get_autocommit"; is_autocommit: boolean } }
  | { type: "error"; error: { message: string; code?: string } };

// ---------------------------------------------------------------------------
// Value conversion
// ---------------------------------------------------------------------------

function toHrana(value: unknown): HranaValue {
  if (value === null || value === undefined) return { type: "null" };
  if (typeof value === "bigint") return { type: "integer", value: String(value) };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { type: "integer", value: String(value) } : { type: "float", value };
  }
  if (typeof value === "boolean") return { type: "integer", value: value ? "1" : "0" };
  if (typeof value === "string") return { type: "text", value };
  if (value instanceof Uint8Array) return { type: "blob", base64: Buffer.from(value).toString("base64") };
  if (value instanceof ArrayBuffer) return { type: "blob", base64: Buffer.from(new Uint8Array(value)).toString("base64") };
  return { type: "text", value: String(value) };
}

function fromHrana(value: HranaValue | undefined): unknown {
  if (!value || value.type === "null") return null;
  if (value.type === "integer") return BigInt(value.value);
  if (value.type === "float") return value.value;
  if (value.type === "text") return value.value;
  if (value.type === "blob") return new Uint8Array(Buffer.from(value.base64, "base64"));
  return null;
}

function argsOf(stmt: HranaStmt, sqlCache: Map<number, string>): unknown[] {
  const out: unknown[] = (stmt.args ?? []).map(fromHrana);
  for (const named of stmt.named_args ?? []) {
    // The file driver accepts named args as `:name`; rewrite to positional-ish
    // form by appending — good enough for the statements this app sends (it
    // never uses named args, so this is a safety net only).
    out.push(fromHrana(named.value));
  }
  return out;
}

function sqlOf(stmt: HranaStmt, sqlCache: Map<number, string>): string {
  if (typeof stmt.sql === "string") return stmt.sql;
  if (typeof stmt.sql_id === "number") {
    const cached = sqlCache.get(stmt.sql_id);
    if (cached) return cached;
    throw new Error(`SQL id ${stmt.sql_id} is not cached on this stream`);
  }
  throw new Error("statement carries neither sql nor sql_id");
}

// ---------------------------------------------------------------------------
// Failure / latency injection
// ---------------------------------------------------------------------------

export type FailureMode = "none" | "http500" | "http429" | "silent" | "reset" | "slow-then-ok";

export interface StubStats {
  /** HTTP requests received (each one is a Turso round trip). */
  requests: number;
  /** SQL statements executed. */
  statements: number;
  /** Batches executed. */
  batches: number;
  /** Transactions currently open (batons). */
  openStreams: number;
  /** Round trips per URL path, for assertions. */
  byPath: Record<string, number>;
  /** The last N statements, for debugging a failing test. */
  recentSql: string[];
}

export interface TursoStub {
  url: string;
  port: number;
  stats: StubStats;
  /** Reset counters (e.g. between "cold start" and "warm path" phases). */
  resetStats(): void;
  /** Add artificial round-trip latency, in ms. */
  setLatency(ms: number): void;
  /** Make the server misbehave the way a real cloud database sometimes does. */
  setFailure(mode: FailureMode): void;
  /** Require this bearer token (undefined = accept anything). */
  setAuthToken(token: string | undefined): void;
  close(): Promise<void>;
  /** The underlying file client — lets a test seed or inspect data directly. */
  readonly local: Client;
}

export interface StubOptions {
  /** Path of the backing SQLite file (a throwaway one per test run). */
  file: string;
  port?: number;
  latencyMs?: number;
  authToken?: string;
  /** Log every round trip to stdout (off by default; noisy). */
  verbose?: boolean;
}

/**
 * Start the stub. Resolves once it is listening; `url` is what
 * `TURSO_DATABASE_URL` should be set to.
 */
export async function startTursoStub(opts: StubOptions): Promise<TursoStub> {
  const local: Client = createClient({ url: `file:${opts.file}`, intMode: "number" });

  const stats: StubStats = {
    requests: 0,
    statements: 0,
    batches: 0,
    openStreams: 0,
    byPath: {},
    recentSql: [],
  };

  let latencyMs = opts.latencyMs ?? 0;
  let failure: FailureMode = "none";
  let authToken = opts.authToken;

  /** baton → live stream state (interactive transactions span requests). */
  const streams = new Map<string, { tx: Transaction | null; sqlCache: Map<number, string>; createdAt: number }>();
  let batonSeq = 0;
  const nextBaton = () => `baton-${++batonSeq}`;

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function executeOn(
    tx: Transaction | null,
    sql: string,
    args: unknown[],
  ): Promise<StmtResult> {
    const stmt: InStatement = { sql, args: args as never };
    const rs = tx ? await tx.execute(stmt) : await local.execute(stmt);
    stats.statements += 1;
    stats.recentSql.push(sql.replace(/\s+/g, " ").slice(0, 160));
    if (stats.recentSql.length > 40) stats.recentSql.shift();
    // The local driver hands back Row OBJECTS (name → value); Hrana carries
    // positional arrays, so project through `columns` — exactly the conversion
    // libsql-server does before it puts a row on the wire.
    const cols = rs.columns.map((name) => ({ name, decltype: null }));
    const rows = (rs.rows as unknown as Array<Record<string, unknown>>).map((row) =>
      rs.columns.map((name) => toHrana(row[name])),
    );
    const result: StmtResult = {
      cols,
      rows,
      affected_row_count: Number(rs.rowsAffected ?? 0),
    };
    if (rs.lastInsertRowid !== undefined) result.last_insert_rowid = String(rs.lastInsertRowid);
    return result;
  }

  function evalCond(cond: BatchCond | undefined, ok: boolean[], errored: boolean[]): boolean {
    if (!cond) return true;
    switch (cond.type) {
      case "ok":
        return ok[cond.step] === true;
      case "error":
        return errored[cond.step] === true;
      case "not":
        return !evalCond(cond.cond, ok, errored);
      case "and":
        return cond.conds.every((c) => evalCond(c, ok, errored));
      case "or":
        return cond.conds.some((c) => evalCond(c, ok, errored));
      case "is_autocommit":
        return true;
      default:
        return true;
    }
  }

  /** Run one batch exactly the way libsql-server does: steps, conditions, txn. */
  async function runBatch(
    state: { tx: Transaction | null; sqlCache: Map<number, string> },
    steps: HranaBatchStep[],
  ): Promise<{ step_results: Array<StmtResult | null>; step_errors: Array<{ message: string } | null> }> {
    const stepResults: Array<StmtResult | null> = [];
    const stepErrors: Array<{ message: string } | null> = [];
    const ok: boolean[] = [];
    const errored: boolean[] = [];
    // Opened BY this batch (so this batch also commits/rolls it back).
    let ownedTx: Transaction | null = null;
    let anyError = false;

    for (const step of steps) {
      const idx = stepResults.length;
      if (!evalCond(step.condition, ok, errored)) {
        stepResults.push(null);
        stepErrors.push(null);
        ok.push(false);
        errored.push(false);
        continue;
      }
      let sql: string;
      try {
        sql = sqlOf(step.stmt, state.sqlCache);
      } catch (err) {
        stepResults.push(null);
        stepErrors.push({ message: (err as Error).message });
        ok.push(false);
        errored.push(true);
        anyError = true;
        continue;
      }
      const trimmed = sql.trim().toUpperCase();
      try {
        if (trimmed.startsWith("BEGIN")) {
          // A transaction starts here; later steps (possibly in later requests,
          // correlated by baton) run inside it.
          if (!state.tx) {
            ownedTx = await local.transaction("write");
            state.tx = ownedTx;
          }
          stepResults.push({ cols: [], rows: [], affected_row_count: 0 });
          stepErrors.push(null);
          ok.push(true);
          errored.push(false);
          continue;
        }
        if (trimmed.startsWith("COMMIT")) {
          const tx = state.tx;
          state.tx = null;
          ownedTx = null;
          if (tx) await tx.commit();
          stepResults.push({ cols: [], rows: [], affected_row_count: 0 });
          stepErrors.push(null);
          ok.push(true);
          errored.push(false);
          continue;
        }
        if (trimmed.startsWith("ROLLBACK")) {
          const tx = state.tx;
          state.tx = null;
          ownedTx = null;
          if (tx) await tx.rollback();
          stepResults.push({ cols: [], rows: [], affected_row_count: 0 });
          stepErrors.push(null);
          ok.push(true);
          errored.push(false);
          continue;
        }
        if (trimmed.startsWith("PRAGMA FOREIGN_KEYS")) {
          // Emulated: libsql-server accepts these around a migrate batch.
          stepResults.push({ cols: [], rows: [], affected_row_count: 0 });
          stepErrors.push(null);
          ok.push(true);
          errored.push(false);
          continue;
        }
        const result = await executeOn(state.tx, sql, argsOf(step.stmt, state.sqlCache));
        stepResults.push(result);
        stepErrors.push(null);
        ok.push(true);
        errored.push(false);
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        stepResults.push(null);
        stepErrors.push({ message });
        ok.push(false);
        errored.push(true);
        anyError = true;
      }
    }

    // A failed step rolls the batch's own transaction back, as libsql-server does.
    if (anyError && (ownedTx || state.tx)) {
      const tx = state.tx;
      state.tx = null;
      try {
        if (tx) await tx.rollback();
      } catch {
        /* already gone */
      }
    }
    stats.batches += 1;
    return { step_results: stepResults, step_errors: stepErrors };
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const path = (req.url ?? "/").split("?")[0];
    stats.requests += 1;
    stats.byPath[path] = (stats.byPath[path] ?? 0) + 1;

    // --- injected misbehaviour -------------------------------------------
    if (failure === "reset") {
      res.socket?.destroy();
      return;
    }
    if (failure === "silent") {
      // Never answer: exactly the "accepted the connection and went quiet"
      // failure that hangs a client with no deadline of its own.
      return;
    }
    if (failure === "http500") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream error");
      return;
    }
    if (failure === "http429") {
      res.writeHead(429, { "content-type": "text/plain", "retry-after": "5" });
      res.end("too many requests");
      return;
    }
    if (latencyMs > 0) await sleep(latencyMs);

    // --- version probe (only used by protocol v3 clients) ----------------
    if (req.method === "GET" && (path === "/v2" || path === "/v3-protobuf" || path === "/version")) {
      if (path === "/v3-protobuf") {
        // Force the JSON v2 fallback, which is what Turso answers for this
        // client version and what the stub implements.
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "v2" }));
      return;
    }

    if (req.method !== "POST" || !path.endsWith("/pipeline")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `unexpected ${req.method} ${path}` }));
      return;
    }

    // --- auth ------------------------------------------------------------
    if (authToken) {
      const header = String(req.headers.authorization ?? "");
      if (header !== `Bearer ${authToken}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "invalid token" }));
        return;
      }
    }

    // --- body ------------------------------------------------------------
    let body: PipelineReq;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as PipelineReq;
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `bad pipeline request: ${(err as Error).message}` }));
      return;
    }

    // A baton resumes an existing stream; otherwise this request opens one.
    let state = body.baton ? streams.get(body.baton) : undefined;
    if (body.baton && !state) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "unknown or expired baton" }));
      return;
    }
    if (!state) {
      state = { tx: null, sqlCache: new Map(), createdAt: Date.now() };
    }

    const results: StreamResult[] = [];
    let closed = false;

    try {
      for (const request of body.requests ?? []) {
        switch (request.type) {
          case "close": {
            closed = true;
            results.push({ type: "ok", response: { type: "close" } });
            break;
          }
          case "store_sql": {
            state.sqlCache.set(request.sql_id, request.sql);
            results.push({ type: "ok", response: { type: "store_sql" } });
            break;
          }
          case "close_sql": {
            state.sqlCache.delete(request.sql_id);
            results.push({ type: "ok", response: { type: "close_sql" } });
            break;
          }
          case "execute": {
            try {
              const sql = sqlOf(request.stmt, state.sqlCache);
              const result = await executeOn(state.tx, sql, argsOf(request.stmt, state.sqlCache));
              results.push({ type: "ok", response: { type: "execute", result } });
            } catch (err) {
              results.push({ type: "error", error: { message: (err as Error)?.message ?? String(err) } });
            }
            break;
          }
          case "batch": {
            try {
              const result = await runBatch(state, request.batch.steps);
              results.push({ type: "ok", response: { type: "batch", result } });
            } catch (err) {
              results.push({ type: "error", error: { message: (err as Error)?.message ?? String(err) } });
            }
            break;
          }
          case "sequence": {
            try {
              const sql = request.sql ?? (request.sql_id !== undefined ? state.sqlCache.get(request.sql_id) : undefined);
              if (!sql) throw new Error("sequence without sql");
              for (const part of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
                await executeOn(state.tx, part, []);
              }
              results.push({ type: "ok", response: { type: "sequence" } });
            } catch (err) {
              results.push({ type: "error", error: { message: (err as Error)?.message ?? String(err) } });
            }
            break;
          }
          case "get_autocommit": {
            results.push({ type: "ok", response: { type: "get_autocommit", is_autocommit: state.tx === null } });
            break;
          }
          case "describe": {
            results.push({
              type: "ok",
              response: { type: "describe", result: { params: [], cols: [], is_explain: false, is_readonly: false } },
            });
            break;
          }
          default: {
            results.push({ type: "error", error: { message: `unsupported request type ${(request as { type: string }).type}` } });
          }
        }
      }
    } catch (err) {
      results.push({ type: "error", error: { message: (err as Error)?.message ?? String(err) } });
    }

    // Baton bookkeeping: an open transaction survives to the next request; a
    // closed stream does not (and anything it left open is rolled back).
    let batonOut: string | undefined;
    if (closed) {
      if (body.baton) streams.delete(body.baton);
      if (state.tx) {
        try {
          await state.tx.rollback();
        } catch {
          /* already finished */
        }
        state.tx = null;
      }
    } else if (state.tx) {
      batonOut = nextBaton();
      if (body.baton) streams.delete(body.baton);
      streams.set(batonOut, state);
    } else {
      if (body.baton) streams.delete(body.baton);
    }
    stats.openStreams = streams.size;

    if (opts.verbose) {
      const kinds = (body.requests ?? []).map((r) => r.type).join(",");
      console.log(
        `[TURSO-STUB] ${path} requests=[${kinds}] baton=${body.baton ?? "-"} -> ${batonOut ?? "-"} (${Date.now() - started}ms)`,
      );
    }

    const payload: Record<string, unknown> = { results };
    if (batonOut) payload.baton = batonOut;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const bound = (server.address() as AddressInfo).port;

  // Reap streams whose client vanished mid-transaction, so a test that aborts a
  // request cannot leak a write lock into the next one.
  const reaper = setInterval(() => {
    const cutoff = Date.now() - 30_000;
    for (const [baton, state] of streams) {
      if (state.createdAt < cutoff) {
        streams.delete(baton);
        void state.tx?.rollback().catch(() => undefined);
      }
    }
  }, 5_000);
  reaper.unref?.();

  return {
    url: `http://127.0.0.1:${bound}`,
    port: bound,
    stats,
    local,
    resetStats() {
      stats.requests = 0;
      stats.statements = 0;
      stats.batches = 0;
      stats.byPath = {};
      stats.recentSql = [];
    },
    setLatency(ms: number) {
      latencyMs = Math.max(0, ms);
    },
    setFailure(mode: FailureMode) {
      failure = mode;
    },
    setAuthToken(token: string | undefined) {
      authToken = token;
    },
    async close() {
      clearInterval(reaper);
      for (const state of streams.values()) {
        try {
          await state.tx?.rollback();
        } catch {
          /* ignore */
        }
      }
      streams.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      local.close();
    },
  };
}
