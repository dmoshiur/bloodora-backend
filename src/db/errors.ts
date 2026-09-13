/**
 * Turning a database failure into an honest HTTP answer.
 *
 * ============================== WHY THIS EXISTS =============================
 * Verified against the real remote transport (`tests/remote.test.mts`, which
 * speaks Hrana-over-HTTP to `tests/turso-stub.mts`): when Turso answered 500 or
 * dropped the connection, every data route replied
 *
 *     500 {"error":{"code":"INTERNAL","message":"Something went wrong. Please try again."}}
 *
 * That is the wrong answer twice over:
 *
 *   1. **It is a lie about ownership.** `500 INTERNAL` says "this application has
 *      a bug". A dependency being down is not a bug, and an operator paging
 *      through logs at 3am is sent looking at our code instead of at Turso's
 *      status page. The correct answer is `503` + `retryable`, which is also what
 *      lets a client back off and try again instead of surfacing a dead end.
 *   2. **It is indistinguishable from a real crash** to the frontend, which is
 *      exactly how "the database blipped" became "the server crashed".
 *
 * What must NOT be remapped: SQL-level errors. `SQLITE_CONSTRAINT_UNIQUE` is how
 * `EMAIL_TAKEN` (409) is detected, `SQLITE_ERROR: no such column` is a genuine
 * bug worth a 500 and a stack in the logs. Only *transport and dependency*
 * failures are rewritten here — everything else passes through untouched.
 *
 * Nothing in this file may put a host, URL, token, SQL statement or driver stack
 * into a value that reaches a response body. `publicReason()` exists precisely so
 * the health endpoint can say *why* without saying *where*.
 * ===========================================================================
 */

import { logger } from "../utils/logger.js";

/** Coarse, leak-free categories. Safe to return to a browser. */
export type DbFailureReason =
  | "timeout"
  | "unreachable"
  | "server_error"
  | "rate_limited"
  | "auth_rejected"
  | "not_configured"
  | "closed"
  | "unknown";

/** The public envelope for "the database is not usable right now". */
export const DB_UNAVAILABLE_MESSAGE = "Database service is temporarily unavailable. Please try again.";

interface Shaped {
  status?: number;
  code?: string;
  message?: string;
  retryable?: boolean;
  reason?: DbFailureReason;
  retryAfterMs?: number;
}

/** Error codes @libsql/client produces for transport-level failures. */
const TRANSPORT_CODES = new Set([
  "SERVER_ERROR", // Hrana: non-2xx from the server (HTTP 5xx, 429, 401 …)
  "HRANA_CLOSED_ERROR",
  "HRANA_WEBSOCKET_ERROR",
  "HRANA_PROTO_ERROR",
  "HRANA_HTTP_ERROR",
  "PROTOCOL_VERSION_ERROR",
  "TRANSACTION_CLOSED", // a batch/transaction died mid-flight, usually because the stream did
  "URL_INVALID",
  "URL_SCHEME_NOT_SUPPORTED",
]);

/**
 * Phrases that mean "the database refused who we are", not "our SQL was wrong".
 * Only consulted after `isSqlError()` has ruled a statement failure out.
 */
const AUTH_PHRASES = [
  "invalid token",
  "invalid bearer",
  "authentication failed",
  "authentication error",
  "unauthorized",
  "unauthorised",
  "forbidden",
  "jwt",
  "access denied",
];

/**
 * Error classes the libSQL/Hrana stack throws. Used to decide whether a *message*
 * heuristic may be applied at all.
 *
 * This matters more than it looks. `AUTH_PHRASES` below matches words like
 * "unauthorized" and "jwt" — which are also how THIS API describes a missing or
 * malformed bearer token. Applying the heuristic to any error remapped a perfectly
 * correct `401 Unauthorized` from the auth middleware into
 * `503 DB_AUTH_FAILED`, i.e. it turned "you are not logged in" into "the database
 * credentials are broken". So the phrase list is only ever consulted for errors
 * the driver itself produced; everything else keeps its own meaning.
 */
const DRIVER_ERROR_NAMES = new Set([
  "LibsqlError",
  "ClientError",
  "ResponseError",
  "HttpServerError",
  "ClosedError",
  "ProtoError",
  "WebSocketError",
  "WebSocketUnsupportedError",
  "ProtocolVersionError",
  "LibsqlUrlParseError",
  "InternalError",
]);

/** True when the error (or anything in its cause chain) came from the libSQL driver. */
export function isDriverError(err: unknown): boolean {
  for (const link of chain(err)) {
    if (DRIVER_ERROR_NAMES.has(nameOf(link))) return true;
    // Our own shaped 503 is, by construction, about the database.
    if ((link as { dependency?: unknown })?.dependency === true) return true;
    // A transport-level status only ever comes from the database response.
    if (statusOf(link) >= 400) return true;
  }
  return false;
}

/** Socket-level causes (undici/libuv) that mean "we never got an answer". */
const SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_REQ_RETRY",
  "ABORT_ERR",
]);

/**
 * A SQL-level failure is never a dependency failure — and over the real remote
 * transport that distinction cannot be made from `err.code` alone.
 *
 * Verified against the live Hrana-over-HTTP path (`tests/turso-stub.mts`):
 *
 *   UNIQUE violation -> LibsqlError{ code: "UNKNOWN",
 *      message: "UNKNOWN: SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: t.a" }
 *
 * `@libsql/client` only copies `code` from the server when the driver set one; a
 * statement error comes back as `UNKNOWN` with the SQLite code inside the
 * message. So the message is the reliable signal, and it is checked FIRST: any
 * `SQLITE_*` marker in the chain means "the database answered, it just did not
 * like our SQL", which must keep flowing to the 409/500 handlers untouched.
 */
const SQL_MARKER = /SQLITE_[A-Z_]+/;

/** True when the database answered and rejected the SQL itself. */
export function isSqlError(err: unknown): boolean {
  for (const link of chain(err)) {
    if (SQL_MARKER.test(messageOf(link))) return true;
  }
  return false;
}

function codeOf(err: unknown): string {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return String(e?.code ?? e?.cause?.code ?? "");
}

/** The HTTP status a transport-level error carries, or 0 when it has none. */
export function statusOf(err: unknown): number {
  const value = Number((err as { status?: unknown })?.status ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function messageOf(err: unknown): string {
  const e = err as { message?: unknown };
  return typeof e?.message === "string" ? e.message : String(err ?? "");
}

function nameOf(err: unknown): string {
  const e = err as { name?: unknown };
  return typeof e?.name === "string" ? e.name : "";
}

/** Walk a short `cause` chain: undici nests the real socket error one level down. */
function* chain(err: unknown): Generator<unknown> {
  let current: unknown = err;
  for (let i = 0; i < 5 && current; i += 1) {
    yield current;
    current = (current as { cause?: unknown })?.cause;
  }
}

/** True when the failure is our own deadline firing (already shaped 503). */
export function isOurTimeout(err: unknown): boolean {
  return nameOf(err) === "TimeoutError";
}

/**
 * True when the database could not be *reached or used*, as opposed to the
 * database telling us our SQL was wrong.
 */
export function isDbDependencyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if (isOurTimeout(err)) return true;
  // Already shaped by the transport layer (a non-2xx Turso response). The breaker
  // must still count these, or one misconfigured token would keep every request
  // paying the full round trip instead of failing fast.
  if ((err as { dependency?: unknown }).dependency === true) return true;
  // The database answered our SQL with a complaint. Not ours to remap.
  if (isSqlError(err)) return false;

  for (const link of chain(err)) {
    const code = codeOf(link);
    if (code && (TRANSPORT_CODES.has(code) || SOCKET_CODES.has(code))) return true;
    // hrana's HttpServerError carries the HTTP status of the failed response.
    const status = statusOf(link);
    if (status >= 400) return true;
  }

  // Message heuristics are only trustworthy for errors the driver produced: the
  // same words appear in this API's own auth errors (see DRIVER_ERROR_NAMES).
  if (!isDriverError(err)) return false;

  const msg = messageOf(err).toLowerCase();
  // undici's network failure, and the "client was closed" family.
  if (msg.includes("fetch failed")) return true;
  if (msg.includes("terminated") && msg.includes("undici")) return true;
  if (msg.includes("client is closed") || msg.includes("stream is closed") || msg.includes("stream is closing")) return true;
  if (msg.includes("server returned http status")) return true;
  if (msg.includes("socket hang up") || msg.includes("other side closed")) return true;
  // A missing/invalid Turso configuration is a dependency problem too: it must be
  // a 503 an operator can act on, never a 500 that looks like a code bug.
  if (msg.includes("turso_database_url") || msg.includes("production requires turso")) return true;
  // Turso's 401 body is `{"message":"invalid token"}`. hrana parses it as a
  // protocol error, so it arrives with `code: "UNKNOWN"` and no status anywhere —
  // the exact shape that used to be reported to the browser as a 500 INTERNAL.
  if (AUTH_PHRASES.some((phrase) => msg.includes(phrase))) return true;

  return false;
}

/**
 * The leak-free reason for a dependency failure. Returned to clients (health
 * endpoint, error `details`); the technical message goes to the log instead.
 */
export function publicReason(err: unknown): DbFailureReason {
  if (isOurTimeout(err)) return "timeout";
  if ((err as { dependency?: unknown })?.dependency === true) {
    const reason = (err as { reason?: unknown }).reason;
    if (typeof reason === "string") return reason as DbFailureReason;
  }
  // Already classified (the transport layer shapes its own 503s): keep its reason
  // instead of re-deriving one from a message that no longer carries the status.
  const shaped = (err as { dependency?: unknown; reason?: unknown }) ?? undefined;
  if (shaped?.dependency === true && typeof shaped.reason === "string") {
    return shaped.reason as DbFailureReason;
  }
  const msg = messageOf(err).toLowerCase();
  if (msg.includes("turso_database_url") || msg.includes("production requires turso")) return "not_configured";

  for (const link of chain(err)) {
    const code = codeOf(link);
    if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
      return "timeout";
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
      return "unreachable";
    }
    if (code === "SERVER_ERROR") {
      const status = Number(/http status (\d{3})/.exec(msg)?.[1] ?? 0);
      return reasonForStatus(status) ?? "server_error";
    }
    const status = statusOf(link);
    if (status >= 400) return reasonForStatus(status) ?? "server_error";
  }

  if (isDriverError(err) && AUTH_PHRASES.some((phrase) => msg.includes(phrase))) return "auth_rejected";

  if (msg.includes("fetch failed") || msg.includes("socket hang up") || msg.includes("other side closed")) return "unreachable";
  if (msg.includes("client is closed") || msg.includes("stream is closed") || msg.includes("stream is closing")) return "closed";
  return "unknown";
}

/**
 * Build the shaped 503 for a dependency failure.
 *
 * `detail` is logged here — once, at the point of classification, with the
 * operation name — so the technical truth is in the server logs while the client
 * gets a message it can act on.
 */
type Shaped503 = Error & Required<Pick<Shaped, "status" | "code" | "message">> & Shaped;

/**
 * Map an HTTP status returned by the database service onto a leak-free reason.
 * Returns `undefined` for statuses that carry no dependency meaning.
 */
export function reasonForStatus(status: number): DbFailureReason | undefined {
  if (status === 401 || status === 403) return "auth_rejected";
  if (status === 404 || status === 410) return "not_configured"; // wrong URL / database gone
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 499) return "timeout";
  if (status >= 500) return "server_error";
  return undefined;
}

/**
 * The shaped 503 for a transport response we could not use.
 *
 * Thrown from `timedFetch`, the only place that sees the real HTTP status of a
 * Turso response. Everything above it receives a mangled version — hrana turns
 * `401 {"message":"invalid token"}` into an error with `code: "UNKNOWN"` and no
 * status — so classifying here is the difference between an honest
 * `503 DB_AUTH_FAILED` and a misleading `500 INTERNAL`.
 */
export function transportStatusError(status: number, operation: string, detail = ""): Shaped503 {
  const reason = reasonForStatus(status) ?? "server_error";
  logger.warn("db: transport rejected the request", {
    operation,
    status,
    reason,
    // Server-side only: may name the database or quote its body.
    detail: detail.slice(0, 300),
  });
  return dbUnavailable(reason, reason === "rate_limited" ? 2_000 : 1_000);
}

/** The message a client sees for each leak-free failure category. */
function messageFor(reason: DbFailureReason): string {
  if (reason === "auth_rejected") {
    return "Database authentication failed. An operator needs to check the database credentials.";
  }
  if (reason === "not_configured") return "The database is not configured on this deployment.";
  return DB_UNAVAILABLE_MESSAGE;
}

/** The stable code a client branches on for each category. */
function codeFor(reason: DbFailureReason): string {
  if (reason === "auth_rejected") return "DB_AUTH_FAILED";
  if (reason === "not_configured") return "DB_NOT_CONFIGURED";
  return "DB_UNAVAILABLE";
}

/**
 * Build the shaped 503 for a KNOWN reason, without logging it.
 *
 * The breaker calls this for every request it refuses, so logging here would turn
 * one outage into one log line per request; the state transitions are logged by
 * `src/db/breaker.ts` instead.
 */
export function dbUnavailable(reason: DbFailureReason, retryAfterMs = 1_000): Shaped503 {
  const message = messageFor(reason);
  return Object.assign(new Error(message), {
    status: 503,
    code: codeFor(reason),
    message,
    retryable: reason !== "auth_rejected" && reason !== "not_configured",
    reason,
    retryAfterMs,
    /** "this is a dependency failure" — see isDbDependencyError(). */
    dependency: true,
  }) as never;
}

export function dbUnavailableError(err: unknown, operation: string, retryAfterMs = 1_000): Shaped503 {
  if (isOurTimeout(err)) {
    // Our own TimeoutError is ALREADY shaped (503 + DB_TIMEOUT/DB_NOT_READY) and
    // already logged by the layer that created it. Pass it through unchanged so
    // the specific operation and wait time survive to the client.
    return err as never;
  }
  const reason = publicReason(err);
  logger.warn("db: dependency failure — answering 503", {
    operation,
    reason,
    // The raw driver message, which may name the host. Server-side only.
    detail: messageOf(err).slice(0, 300),
    code: codeOf(err) || undefined,
  });
  return dbUnavailable(reason, retryAfterMs);
}

/**
 * Classify an error coming out of a database call.
 *
 * Dependency failure → shaped 503 (safe message, `retryable`). Anything else is
 * returned untouched so SQL constraints keep meaning 409 and real bugs keep
 * meaning 500 with their stack in the log.
 */
export function classifyDbError(err: unknown, operation: string): unknown {
  if (!isDbDependencyError(err)) return err;
  return dbUnavailableError(err, operation);
}
