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

console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
if (failures.length) {
  console.log("Failures:");
  failures.forEach((f) => console.log(` - ${f}`));
}
process.exitCode = failures.length === 0 ? 0 : 1;
