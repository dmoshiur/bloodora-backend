#!/usr/bin/env npx tsx
/**
 * Deployment regression guard.
 *
 * This project has already shipped one broken Vercel deployment:
 *
 *   Invalid export found in module /var/task/server.js —
 *   The default export must be a function or server.
 *   → Node.js process exited with exit status: 1
 *   → FUNCTION_INVOCATION_FAILED / a public timeout
 *
 * Every assertion below pins one of the properties whose absence produced that
 * failure (or would produce it again). They are cheap, run without a database or
 * network, and are meant to fail in CI long before `vercel deploy` does.
 *
 * Usage: npm run test:deploy
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

/**
 * Source with comments removed, for assertions about what the code DOES.
 *
 * Several of these files document the mistake they avoid ("There is deliberately
 * NO app.listen() here"), so matching the raw text would flag the warning as the
 * bug it is warning about.
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

let pass = 0;
const failures: string[] = [];
const step = (name: string, ok: boolean, extra = "") => {
  if (ok) pass += 1;
  else {
    failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
    console.log(`  FAIL ${name} ${extra}`);
  }
};

// ---------------- vercel.json ----------------

step("vercel.json exists", existsSync(path.join(ROOT, "vercel.json")));
let vc: any = null;
try {
  vc = JSON.parse(read("vercel.json"));
  step("vercel.json is valid JSON", true);
} catch (err) {
  step("vercel.json is valid JSON", false, String(err));
}

if (vc) {
  // The legacy `routes` array and the higher-level `rewrites`/`redirects`/
  // `headers` keys are two different routing systems. Vercel tolerates them
  // side by side only in narrow cases, and mixing them is what produced
  // conflicting behaviour here before: one system rewrote the path, the other
  // dispatched it, and the function that finally ran was not the one the
  // rewrite targeted.
  step("vercel.json does not mix legacy `routes` with `rewrites`", !(vc.routes && vc.rewrites), JSON.stringify({ routes: !!vc.routes, rewrites: !!vc.rewrites }));
  step("vercel.json has no legacy `routes` block", !vc.routes);
  step("vercel.json has no `builds` block (the api/ directory is auto-detected)", !vc.builds);

  const rewrites = vc.rewrites || [];
  step("exactly one rewrite rule", rewrites.length === 1, JSON.stringify(rewrites));
  step("the rewrite sends every path to the /api function", rewrites[0]?.source === "/(.*)" && rewrites[0]?.destination === "/api", JSON.stringify(rewrites[0]));

  const fns = vc.functions || {};
  step("api/index.ts is declared as the function entrypoint", !!fns["api/index.ts"], JSON.stringify(Object.keys(fns)));
  // `src/server.ts` is a library-style handler export, not a platform
  // entrypoint. Declaring it makes Vercel build a SECOND function that no route
  // can reach — and doubles the surface for the "invalid export" failure.
  step("no non-entrypoint file is declared as a function", !Object.keys(fns).some((k) => k.startsWith("src/")), JSON.stringify(Object.keys(fns)));
  step("function memory is within the allowed range", !fns["api/index.ts"]?.memory || (fns["api/index.ts"].memory >= 128 && fns["api/index.ts"].memory <= 3008), JSON.stringify(fns["api/index.ts"]));
  // maxDuration above 10 s is rejected on the Hobby plan and fails the deploy.
  step("maxDuration (if set) is deployable on Hobby", fns["api/index.ts"]?.maxDuration === undefined || fns["api/index.ts"].maxDuration <= 10, JSON.stringify(fns["api/index.ts"]?.maxDuration));
}

// ---------------- the function entrypoint ----------------

step("api/index.ts exists", existsSync(path.join(ROOT, "api/index.ts")));
const entry = read("api/index.ts");
step("api/index.ts has a default export", /export\s+default\s+handler/.test(entry));
step("api/index.ts never calls listen() (the platform owns the socket)", !/\.listen\(/.test(code(entry)));
step("api/index.ts survives a createApp() failure instead of failing to export", /try\s*{[\s\S]*?createApp\(\)[\s\S]*?}\s*catch/.test(entry));

const server = read("src/server.ts");
step("src/server.ts has a default export", /export\s+default\s+handler/.test(server));
step("src/server.ts never calls listen()", !/\.listen\(/.test(code(server)));

const app = read("src/app.ts");
step("src/app.ts exports an app factory, not a listening server", /export\s+default\s+createApp/.test(app) && !/\.listen\(/.test(code(app)));
step("src/app.ts uses the persistent (Turso) session store, never MemoryStore", /TursoSessionStore/.test(app) && !/new\s+session\.MemoryStore/.test(app));
step("only src/dev.ts listens on a port", /\.listen\(/.test(code(read("src/dev.ts"))));

// Importing the entrypoint must yield a callable handler WITHOUT opening a port
// or touching the database (both would hang or crash a serverless cold start).
process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "deploy-guard-secret-0123456789abcdef";
process.env.FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:3000";

const mod = (await import("../api/index.js")) as { default?: unknown; handler?: unknown };
step("importing api/index.ts yields a default-exported function", typeof mod.default === "function", typeof mod.default);
step("the handler accepts (req, res[, next])", typeof mod.default === "function" && (mod.default as (...a: unknown[]) => unknown).length >= 2, String((mod.default as (...a: unknown[]) => unknown).length));
step("the named `handler` export matches the default", mod.handler === mod.default);

// The handler must be callable with a plain (req, res) pair and must never throw
// synchronously: on the platform a throw at this point is exactly the
// FUNCTION_INVOCATION_FAILED / timeout class of failure this guard exists for.
// A minimal ServerResponse stand-in. It implements the handful of methods the
// middleware stack touches (helmet sets headers, the error handler writes JSON)
// so the request runs to completion instead of logging a TypeError about a
// missing setHeader — noise in a passing suite hides real failures.
const fakeRes = {
  headersSent: false,
  statusCode: 0,
  body: null as unknown,
  _headers: {} as Record<string, unknown>,
  status(c: number) {
    this.statusCode = c;
    return this;
  },
  setHeader(k: string, v: unknown) {
    this._headers[k.toLowerCase()] = v;
    return this;
  },
  getHeader(k: string) {
    return this._headers[k.toLowerCase()];
  },
  removeHeader(k: string) {
    delete this._headers[k.toLowerCase()];
  },
  end(payload?: unknown) {
    if (payload !== undefined) this.body = payload;
    this.headersSent = true;
    return this;
  },
  write(payload: unknown) {
    this.body = payload;
    return true;
  },
  json(payload: unknown) {
    this.body = payload;
    this.headersSent = true;
    return this;
  },
};
let threw: string | null = null;
try {
  (mod.default as (req: unknown, res: unknown) => void)(
    { method: "GET", url: "/api/health", headers: {}, socket: { remoteAddress: "127.0.0.1" } },
    fakeRes,
  );
} catch (err) {
  threw = String((err as Error)?.message ?? err);
}
step("the handler runs a request without throwing synchronously", threw === null, threw ?? "");

// -------------- hang prevention: the "stuck loading forever" guard --------------
//
// The production failure this section pins was NOT a crash and NOT a bad export.
// It was two independent ways for a request to never complete:
//
//   (a) the cold-start bootstrap issued 451 sequential libSQL round trips, which
//       at any realistic Turso RTT outlives the platform's function maxDuration —
//       so the invocation was killed mid-bootstrap, the instance discarded, and
//       the next request started the same 451-statement walk from zero. It never
//       converged: the API "loaded" forever and never served a single response.
//   (b) @libsql/client has NO internal timeout (verified: zero AbortSignal/
//       setTimeout references in its http/node/web transports), and every layer
//       above it awaited it unbounded. An unreachable Turso host therefore hung
//       even GET /api/health indefinitely — reproduced as `curl -m 15 → 000`.
//
// Each assertion below removes one of the properties whose absence allowed that.

const timeoutMod = code(read("src/db/timeout.ts"));
step("src/db/timeout.ts exists", timeoutMod.length > 0);
step("withTimeout() unrefs its timer (never keeps an instance alive)", /unref/.test(timeoutMod));
step("timedFetch() aborts the socket, not just the wait", /AbortController/.test(timeoutMod) && /controller\.abort\(\)/.test(timeoutMod));

// (b) transport-level deadline — the only hook libSQL exposes for one.
const clientSrc = code(read("src/db/client.ts"));
step("getClient() bounds the libSQL transport with a timed fetch", /fetch:\s*timedFetch/.test(clientSrc));
step("the database URL is logged without credentials", /safeHost/.test(clientSrc) && !/tursoAuthToken/.test(clientSrc.slice(clientSrc.indexOf("logger.info"))));

// Every query helper goes through one guarded choke point: breaker gate →
// deadline → classification. Nothing may reach the driver around it.
const querySrc = code(read("src/db/query.ts"));
step("query.ts exposes batch() — one round trip per statement group", /export async function batch/.test(querySrc));
step("single statements go through the guarded choke point", /guarded\("SQL query", \(\) => getClient\(\)\.execute/.test(querySrc));
step("batches go through the guarded choke point", /guarded\(\s*`SQL batch/.test(querySrc));
step("transaction open/steps/commit/rollback all go through it", (querySrc.match(/guarded\("(open transaction|tx statement|tx query|commit transaction|rollback transaction)"/g) || []).length >= 5, String((querySrc.match(/guarded\(/g) || []).length));
step("no database call bypasses the guard (no raw withTimeout left in query.ts)", !/withTimeout\(/.test(querySrc.replace(/await withTimeout\(start\(\), ms, label\)/, "")));
step("the guard consults the breaker BEFORE starting the call", querySrc.indexOf("dbBreaker.allow(") < querySrc.indexOf("await withTimeout(start()"), "gate must precede work");
step("the guard records the outcome so the breaker can open and close", /dbBreaker\.noteSuccess\(/.test(querySrc) && /dbBreaker\.noteFailure\(/.test(querySrc));
step("the health probe bypasses the gate (it must report truth, not our pessimism)", /probeQuery[\s\S]*?true\)/.test(querySrc));

// The breaker itself: fail fast while the database is down, recover by itself.
const breakerSrc = code(read("src/db/breaker.ts"));
step("src/db/breaker.ts exists", breakerSrc.length > 0);
step("the breaker opens only after several consecutive failures", /FAILURE_THRESHOLD/.test(breakerSrc));
step("the breaker admits exactly one half-open trial", /trialInFlight/.test(breakerSrc));
step("the breaker closes itself on the next success (no redeploy needed)", /noteSuccess\(operation/.test(breakerSrc) && /state\.openedAt = 0/.test(breakerSrc));
step("the breaker ignores SQL errors (a buggy query must not close the API)", /if \(!isDbDependencyError\(err\)\)/.test(breakerSrc));
step("an outage backs off instead of retrying in a tight loop", /MAX_COOLDOWN_MS/.test(breakerSrc));

// Classification: a dependency failure is a 503, a SQL failure is left alone.
const dbErrSrc = code(read("src/db/errors.ts"));
step("transport failures are classified as 503 DB_UNAVAILABLE", /status: 503/.test(dbErrSrc) && /DB_UNAVAILABLE/.test(dbErrSrc));
step("socket-level causes are recognised (undici nests them under `cause`)", /for \(const link of chain\(err\)\)/.test(dbErrSrc) && /ECONNRESET/.test(dbErrSrc));
step("a rejected Turso token is distinguished from an outage", /auth_rejected/.test(dbErrSrc));
step("SQL errors are NOT remapped (constraint violations still mean 409)", /if \(!isDbDependencyError\(err\)\) return err;/.test(dbErrSrc));
// The body a client receives is built from the CATEGORY only; the driver's own
// message (which can name the host) is written to the log and goes no further.
const publicBuilder = dbErrSrc.slice(dbErrSrc.indexOf("export function dbUnavailable("), dbErrSrc.indexOf("export function dbUnavailableError("));
step("the client-facing 503 is built from the category, never the driver message", publicBuilder.length > 0 && !/messageOf|err\.message|detail/.test(publicBuilder));
step("the driver message is logged server-side only", /logger\.warn\("db: dependency failure/.test(dbErrSrc) && /detail: messageOf\(err\)/.test(dbErrSrc));
// Over HTTP the driver reports EVERY statement error as `code:"UNKNOWN"` and puts
// the real `SQLITE_*` code in the message (verified against the remote transport),
// so the message is the only reliable way to keep a 409/500 from becoming a 503.
step("a SQL failure is recognised by its message, not by err.code", /SQL_MARKER/.test(dbErrSrc) && /export function isSqlError/.test(dbErrSrc));
step("a SQL failure is ruled out before any transport heuristic runs", dbErrSrc.indexOf("isSqlError(err)") < dbErrSrc.indexOf("fetch failed"));
// The same words describe both problems: Turso rejects a bad token with
// "invalid token"/401, and THIS API rejects a bad bearer token with
// "Unauthorized"/"jwt malformed". Only provenance keeps them apart — guessing
// from the message alone turned a correct 401 into a 503 "database credentials".
step("message heuristics apply only to errors the driver produced", /if \(!isDriverError\(err\)\) return false;/.test(dbErrSrc));
step("driver provenance is judged by error class, transport status or our own shaping", /DRIVER_ERROR_NAMES/.test(dbErrSrc) && /statusOf\(link\) >= 400/.test(dbErrSrc));
step("the HTTP status is classified where only it can still be seen (timedFetch)", /transportStatusError\(resp\.status/.test(code(read("src/db/timeout.ts"))));
const errSrc2 = code(read("src/middleware/error.ts"));
step("a non-retryable dependency failure says so instead of inviting a retry loop", /retryable: reason !== "auth_rejected" && reason !== "not_configured"/.test(dbErrSrc) && /shaped\.retryable === false \? false/.test(errSrc2));

// (a) the schema stage must not cost one request per statement.
const schemaSrc = code(read("src/db/schema.ts"));
const applySchema = schemaSrc.slice(schemaSrc.indexOf("export async function applySchema"));
step("applySchema() sends the DDL as ONE batch", /await batch\(DDL\)/.test(applySchema));
step("applySchema() does NOT loop `await run()` per DDL statement", !/for \(const stmt of DDL\) \{\s*await run/.test(applySchema));
step("applySchema() discovers migrated columns in ONE batched PRAGMA", /await batch\(tables\.map/.test(applySchema));
step("applySchema() issues ALTERs only for genuinely missing columns", /alters\.length > 0/.test(applySchema));
step("applySchema() writes settings defaults as ONE batch", /SETTINGS_DEFAULTS\)\.map/.test(applySchema));

// (a) the bootstrap must be bounded, shared, and skippable when warm.
const initSrc = code(read("src/db/init.ts"));
step("ensureDbReady() bounds the WAIT without abandoning the work", /withDeadline\(startBootstrap\(\)/.test(initSrc));
step("the bootstrap is memoized — one run per instance, never duplicated", /if \(!bootstrapping\)/.test(initSrc));
step("a failed bootstrap is backed off instead of retried per request", /BOOT_RETRY_BACKOFF_MS/.test(initSrc));
step("a warm database can skip seeding entirely", /catalogueFingerprint/.test(initSrc) && /BOOTSTRAP_MARKER/.test(initSrc));
step("seeders are batched, not one request per row", !/for \(const \[filename, b64\] of Object\.entries\(DEFAULT_IMAGES\)\) \{\s*const existing/.test(code(read("src/db/seed.ts"))));
step("RBAC catalogue seeding reads state in one batch", /await batch\(\[`SELECT \* FROM roles`/.test(code(read("src/repos/role.repo.ts"))));

// (b) the health probe must be answerable without the database.
const healthRaw = read("src/controllers/health.controller.ts");
step("the health probe is bounded by its own deadline", /probeQuery<\{ ok: number \}>\(`SELECT 1 AS ok`, \[\], config\.healthDbTimeoutMs\)/.test(code(healthRaw)));
step("health exposes the `ok` boolean a client should branch on", /\bok,\n/.test(healthRaw) || /ok,$/.test(healthRaw.split("res.status")[1] ?? ""));
step("health reports a leak-free failure category", /publicReason\(err\)/.test(code(healthRaw)));
step("health echoes the request ID for support/debugging", /requestId/.test(healthRaw));
step("a successful health probe closes the breaker", /dbBreaker\.noteSuccess\("health probe"\)/.test(code(healthRaw)));
step("health reports the database state explicitly", /database: "connected" \| "unavailable"|database,/.test(healthRaw));
step("health keeps the legacy `db` field the contract suite reads", /db: ok \? "ok" : "error"/.test(healthRaw));

const appSrc = code(read("src/app.ts"));
step("probes bypass the session middleware (no DB read before the health route)", /isProbePath\(req\)/.test(appSrc) && /sessionMiddleware\(req, res, next\)/.test(appSrc));
step("probes bypass the DB bootstrap middleware", /if \(isProbePath\(req\)\) \{\s*next\(\);\s*return;\s*\}/.test(appSrc));
step("a request-level failsafe is mounted before the routes", /app\.use\(requestTimeout\)/.test(appSrc) && appSrc.indexOf("app.use(requestTimeout)") < appSrc.indexOf('app.use("/api"'));
step("boot stages are logged for root-cause debugging", /\[BOOT\]/.test(read("src/app.ts")));

// Request identity + one response shape, both applied before any handler runs.
const ridSrc = code(read("src/middleware/requestId.ts"));
step("every request gets a correlation ID", /newRequestId\(\)/.test(ridSrc));
step("an inbound/platform request ID is reused, not replaced", /x-vercel-id|VERCEL_ID/.test(ridSrc));
step("an inbound ID is sanitised before it is echoed or logged", /sanitizeIncoming/.test(ridSrc));
step("the ID is returned on the response", /setHeader\("X-Request-Id"/.test(ridSrc));
const envSrc = code(read("src/middleware/envelope.ts"));
step("success bodies carry `ok` without touching existing fields", /ok: res\.statusCode < 400/.test(envSrc));
step("the envelope never wraps arrays or binary bodies", /isPlainObject/.test(envSrc));
step("failure bodies carry `ok: false`, a flat `message` and the request ID", /ok: false/.test(errSrc2) && /requestId,/.test(errSrc2));
step("a 503 dependency failure is marked retryable with Retry-After", /breakerRetryAfterSeconds\(\)/.test(errSrc2) && /setHeader\("Retry-After"/.test(errSrc2));
step("the error handler re-classifies a dependency failure that reached it unshaped", /isDbDependencyError\(err\)/.test(errSrc2) && /classifyDbError\(/.test(errSrc2));
step("...but never an error that is already shaped, or that is not the driver's", /status === undefined/.test(errSrc2) && /isDriverError\(err\)/.test(errSrc2));

const rtSrc = code(read("src/middleware/requestTimeout.ts"));
step("the failsafe only fires when nothing has been written yet", /res\.headersSent/.test(rtSrc));
step("the failsafe answers 504 instead of leaving the socket open", /504/.test(rtSrc) && /REQUEST_TIMEOUT/.test(rtSrc));
step("the failsafe never keeps an instance alive", /unref/.test(rtSrc));
step("request logging never includes bodies, cookies or query strings", /split\("\?"\)\[0\]/.test(rtSrc) && !/req\.body/.test(rtSrc) && !/req\.headers\.cookie/.test(rtSrc));
step("every request is logged at INFO in production (LOG_LEVEL=info shows it)", /logger\.info\("\[API\] request"/.test(rtSrc) && /logger\.info\("\[API\] response"/.test(rtSrc));
step("the request log line carries the correlation ID", /requestId,\s*\}\);/.test(rtSrc) || /requestId \}/.test(rtSrc));
step("the failsafe 504 body carries the flat envelope too (it bypasses errorHandler)", /ok: false/.test(rtSrc) && /requestId,/.test(rtSrc));

// (b) the session store sits BEFORE the router, so it must fail fast and open.
const storeSrc = code(read("src/sessions/tursoStore.ts"));
step("every session-store operation is bounded", (storeSrc.match(/this\.bounded\(/g) || []).length >= 5, String((storeSrc.match(/this\.bounded\(/g) || []).length));
step("a failed session read degrades to 'no session', never a hang", /cb\(null, undefined\)/.test(storeSrc));
step("a failed session write still completes the request", /cb\(\);/.test(storeSrc));
// code() strips comments on purpose: both files *document* the MemoryStore
// warning they avoid, and matching the raw text would flag the note as the bug.
step("no MemoryStore anywhere in the app or the store", !/MemoryStore/.test(code(read("src/app.ts"))) && !/MemoryStore/.test(code(read("src/sessions/tursoStore.ts"))));

// (b) every external call is bounded too.
const aiSrc = code(read("src/services/ai.service.ts"));
step("the AI service has exactly one bare fetch() — inside its own timeout helper", (aiSrc.match(/await fetch\(/g) || []).length === 1, String((aiSrc.match(/await fetch\(/g) || []).length));
step("the AI admin round-trips use the bounded helper", (aiSrc.match(/fetchWithTimeout\(/g) || []).length >= 3, String((aiSrc.match(/fetchWithTimeout\(/g) || []).length));
step("the AI timeout is configurable, not hardcoded", /config\.aiTimeoutMs/.test(aiSrc) && !/abort\(\), 60000\)/.test(aiSrc));

const smtpSrc = code(read("src/services/smtp.service.ts"));
step("the SMTP transport sets connect/greeting/socket deadlines", /connectionTimeout/.test(smtpSrc) && /greetingTimeout/.test(smtpSrc) && /socketTimeout/.test(smtpSrc));

const sseSrc = code(read("src/utils/sse.ts"));
step("SSE streams end themselves before the platform kills the function", /sseMaxMs/.test(sseSrc) && /max stream lifetime reached/.test(sseSrc));
step("SSE timers are unref'd and torn down on every close path", /unref/.test(sseSrc) && /onClose/.test(sseSrc));
step("no SSE endpoint hand-rolls its own interval any more", !/setInterval/.test(code(read("src/routes/meta.ts"))) && !/setInterval/.test(code(read("src/controllers/support.controller.ts"))));

// Local dev must not block on the database either.
const devSrc = code(read("src/dev.ts"));
step("src/dev.ts opens its port BEFORE warming the database", devSrc.indexOf("app.listen(") < devSrc.indexOf("bootstrapDatabase()"));

// ---------------- package / build sanity ----------------

const pkg = JSON.parse(read("package.json"));
step("package.json declares ESM (\"type\": \"module\")", pkg.type === "module", pkg.type);
step("a build script exists", typeof pkg.scripts?.build === "string");
step("test scripts cover contract, v3, AI and deploy guards", ["test:contract", "test:v3", "test:ai", "test:deploy"].every((k) => typeof pkg.scripts?.[k] === "string"), JSON.stringify(Object.keys(pkg.scripts || {})));
step("an aggregate `test` script runs every suite", typeof pkg.scripts?.test === "string" && /test:deploy/.test(pkg.scripts.test) && /test:v3/.test(pkg.scripts.test), pkg.scripts?.test);

const envExample = read(".env.example");
step(".env.example documents TURSO_DATABASE_URL", /TURSO_DATABASE_URL/.test(envExample));
step(".env.example documents JWT_SECRET", /JWT_SECRET/.test(envExample));
step(".env.example documents FRONTEND_URL", /FRONTEND_URL/.test(envExample));
step(".env.example documents the SMTP variables the outbox needs", /SMTP_HOST/.test(envExample) && /SMTP_ENABLED/.test(envExample));
step(".env.example documents the deadline knobs", ["DB_TIMEOUT_MS", "DB_BOOTSTRAP_TIMEOUT_MS", "HEALTH_DB_TIMEOUT_MS", "REQUEST_TIMEOUT_MS", "AI_TIMEOUT_MS", "SSE_MAX_MS"].every((k) => envExample.includes(k)), "missing a timeout variable");
step(".env.example documents the caller's reserve", /UPSTREAM_RESERVE_MS/.test(envExample));
step(".env.example documents the circuit breaker", ["DB_BREAKER_THRESHOLD", "DB_BREAKER_COOLDOWN_MS", "DB_BREAKER_MAX_COOLDOWN_MS"].every((k) => envExample.includes(k)), "missing a breaker variable");
step(".env.example's AI default fits inside the caller's budget", /AI_TIMEOUT_MS=(\d+)/.test(envExample) && Number(/AI_TIMEOUT_MS=(\d+)/.exec(envExample)?.[1]) <= 6_000, /AI_TIMEOUT_MS=(\d+)/.exec(envExample)?.[1] ?? "?");
step(".env.example documents no secret VALUES", !/(eyJ|sk-[A-Za-z0-9]{10}|-----BEGIN)/.test(envExample));
step("a remote-transport suite exists (the file: engine cannot exercise the network path)", typeof pkg.scripts?.["test:remote"] === "string", JSON.stringify(Object.keys(pkg.scripts || {})));
step("the aggregate test script runs it", /test:remote/.test(pkg.scripts?.test ?? ""));
step("engines pins the Node major the platform runs (22.x), not an open range", /22/.test(String(pkg.engines?.node)), String(pkg.engines?.node));
step("a production-path e2e suite exists", typeof pkg.scripts?.["test:e2e"] === "string", JSON.stringify(Object.keys(pkg.scripts || {})));
step("the aggregate test script runs the e2e suite", /test:e2e/.test(pkg.scripts?.test ?? ""));

// ---------------- DEP0169: the deprecated `url.parse()` ----------------
//
// Production logs carried
//   (node:NN) [DEP0169] DeprecationWarning: `url.parse()` behavior is deprecated
// and it arrived right next to the outage lines, which is how a cosmetic warning
// gets blamed for an incident. What the investigation established:
//
//   * nothing under src/ or api/ calls `url.parse()` — the app parses URLs with
//     WHATWG `new URL()` only;
//   * the warning therefore comes from a dependency on the platform's Node
//     runtime (it is not even emitted on Node 22.22, only on newer runtimes);
//   * the reachable dependency sites are `parseurl`'s non-fast path (Express only
//     reaches it for a `req.url` that does not start with "/", which the platform
//     never sends) and nodemailer's internal URL helpers (only used when a
//     transport is created from a URL STRING — smtp.service.ts passes an options
//     object, so they never run).
//
// It is a warning, not a crash vector: Node still executes `url.parse()`, and
// DEP0169 has no removal date. These assertions exist so the ONE thing we control
// stays controlled — a new `url.parse()` in our source would be ours to remove,
// and it would make the log line ambiguous again.
const sourceFiles = (dir: string): string[] =>
  readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(rel);
    return /\.m?ts$/.test(entry.name) ? [rel] : [];
  });
const appSource = ["src", "api"].flatMap((dir) => (existsSync(path.join(ROOT, dir)) ? sourceFiles(dir) : []));
step("the app's own sources are scanned for the deprecated API", appSource.length > 20, String(appSource.length));
const legacyParse = appSource.filter((file) => /\burl\.parse\s*\(/.test(code(read(file))));
step("no source file calls the deprecated url.parse() [DEP0169]", legacyParse.length === 0, legacyParse.join(", "));
const legacyImport = appSource.filter((file) =>
  /import\s*\{[^}]*\bparse\b[^}]*\}\s*from\s*["'](?:node:)?url["']|require\(\s*["'](?:node:)?url["']\s*\)/.test(code(read(file))),
);
step("no source file imports the legacy `url` parser", legacyImport.length === 0, legacyImport.join(", "));
step("URLs are parsed with the supported WHATWG API instead", /new URL\(/.test(code(read("src/db/client.ts"))));
step("the runtime is pinned to the Node major this was verified against", /^22/.test(String(pkg.engines?.node)), String(pkg.engines?.node));

console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
if (failures.length) {
  console.log("Failures:");
  failures.forEach((f) => console.log(` - ${f}`));
}
process.exitCode = failures.length === 0 ? 0 : 1;
