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
import { readFileSync, existsSync } from "node:fs";
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

// Every query helper goes through one bounded choke point.
const querySrc = code(read("src/db/query.ts"));
step("query.ts exposes batch() — one round trip per statement group", /export async function batch/.test(querySrc));
step("single statements are bounded", /bounded\(getClient\(\)\.execute/.test(querySrc));
step("batches are bounded", /bounded\(\s*getClient\(\)\.batch/.test(querySrc));
step("transaction open/commit/rollback are all bounded", (querySrc.match(/bounded\(tx\.|bounded\(getClient\(\)\.transaction/g) || []).length >= 4, String((querySrc.match(/bounded\(/g) || []).length));

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
step("the health probe is bounded by its own deadline", /withTimeout\(/.test(code(healthRaw)));
step("health reports the database state explicitly", /database: "connected" \| "unavailable"|database,/.test(healthRaw));
step("health keeps the legacy `db` field the contract suite reads", /db: ok \? "ok" : "error"/.test(healthRaw));

const appSrc = code(read("src/app.ts"));
step("probes bypass the session middleware (no DB read before the health route)", /isProbePath\(req\)/.test(appSrc) && /sessionMiddleware\(req, res, next\)/.test(appSrc));
step("probes bypass the DB bootstrap middleware", /if \(isProbePath\(req\)\) \{\s*next\(\);\s*return;\s*\}/.test(appSrc));
step("a request-level failsafe is mounted before the routes", /app\.use\(requestTimeout\)/.test(appSrc) && appSrc.indexOf("app.use(requestTimeout)") < appSrc.indexOf('app.use("/api"'));
step("boot stages are logged for root-cause debugging", /\[BOOT\]/.test(read("src/app.ts")));

const rtSrc = code(read("src/middleware/requestTimeout.ts"));
step("the failsafe only fires when nothing has been written yet", /res\.headersSent/.test(rtSrc));
step("the failsafe answers 504 instead of leaving the socket open", /504/.test(rtSrc) && /REQUEST_TIMEOUT/.test(rtSrc));
step("the failsafe never keeps an instance alive", /unref/.test(rtSrc));
step("request logging never includes bodies, cookies or query strings", /split\("\?"\)\[0\]/.test(rtSrc) && !/req\.body/.test(rtSrc) && !/req\.headers\.cookie/.test(rtSrc));

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
step(".env.example documents no secret VALUES", !/(eyJ|sk-[A-Za-z0-9]{10}|-----BEGIN)/.test(envExample));
step("a production-path e2e suite exists", typeof pkg.scripts?.["test:e2e"] === "string", JSON.stringify(Object.keys(pkg.scripts || {})));
step("the aggregate test script runs the e2e suite", /test:e2e/.test(pkg.scripts?.test ?? ""));

console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
if (failures.length) {
  console.log("Failures:");
  failures.forEach((f) => console.log(` - ${f}`));
}
process.exitCode = failures.length === 0 ? 0 : 1;
