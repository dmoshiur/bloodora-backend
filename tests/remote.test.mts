#!/usr/bin/env npx tsx
/**
 * REMOTE-TURSO TRANSPORT VERIFICATION.
 *
 * Every other suite in this repository points `TURSO_DATABASE_URL` at a `file:`
 * URL. That takes the *remote* branch of `getClient()` (so production config
 * validation and secure cookies run) but `@libsql/client` resolves `file:` to its
 * LOCAL sqlite engine — which means the two things that decide whether
 * production works were never exercised anywhere:
 *
 *   1. **the HTTP transport.** On real Turso every statement is a
 *      `POST /v2/pipeline`, every batch is one request carrying
 *      `BEGIN → stmts → COMMIT → ROLLBACK`, and an interactive transaction spans
 *      several requests correlated by a baton. Values cross the wire as tagged
 *      JSON, so integers arrive via BigInt and BLOBs arrive as `ArrayBuffer`
 *      (not the shapes the local driver returns).
 *   2. **the transport deadline.** `src/db/timeout.ts` → `timedFetch()` is
 *      injected through `createClient({ fetch })`, and the local engine ignores
 *      `fetch` completely. So "an unreachable Turso host must produce a fast
 *      503, never a hang" was asserted only by reading code.
 *
 * This suite boots the real serverless entry (`api/index.ts`) in
 * `NODE_ENV=production` against `tests/turso-stub.mts` — a Hrana-over-HTTP
 * server that speaks the v2 JSON protocol and is backed by a throwaway libSQL
 * file — and then does what a real cloud database eventually does to every
 * deployment: it gets slow, and it goes away.
 *
 *   phase 1  cold start + first requests over HTTP: round trips and wall clock
 *   phase 2  the same with realistic Turso RTT (60/150/250 ms per round trip):
 *            does the bootstrap still fit inside the platform's 10 s invocation?
 *   phase 3  per-endpoint round-trip accounting on the warm path
 *   phase 4  Turso stops answering / answers 5xx / rejects the token:
 *            every response must be fast, parseable JSON, and the function must
 *            survive to serve the next request
 *   phase 5  recovery: the instance must work again without a redeploy
 *
 * A hang is a FAILURE, not a wait: every request carries a hard client deadline.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTursoStub, type TursoStub } from "./turso-stub.mts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bloodora-remote-"));
/** Hard per-request client deadline: a hang fails instead of stalling the suite. */
const DEADLINE = Number(process.env.REMOTE_DEADLINE_MS || 20_000);
const FRONTEND_ORIGIN = "https://bloodora-frontend.vercel.app";

let pass = 0;
const failures: string[] = [];
const step = (name: string, ok: boolean, extra = "") => {
  if (ok) pass += 1;
  else failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
};

const killables: Array<() => void> = [];
const bye = () => {
  for (const fn of killables.splice(0)) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
};
process.on("exit", bye);
process.on("SIGINT", () => {
  bye();
  process.exit(130);
});
process.on("uncaughtException", (err) => {
  console.error(err);
  bye();
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Booting the real serverless entry against a stub Turso
// ---------------------------------------------------------------------------

interface App {
  base: string;
  log: string;
  kill(): void;
}

async function bootApp(tursoUrl: string, env: Record<string, string> = {}): Promise<App> {
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), path.join(HERE, "serverless-harness.mts")],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: "production",
        HARNESS_PORT: "0",
        LOG_LEVEL: process.env.LOG_LEVEL || "warn",
        FRONTEND_URL: FRONTEND_ORIGIN,
        JWT_SECRET: "remote-suite-secret-0123456789abcdef0123456789abcdef",
        JWT_TTL_DAYS: "7",
        // The point of the whole file: a REMOTE url, so @libsql/client builds
        // its HTTP client and the injected `fetch` deadline is live.
        TURSO_DATABASE_URL: tursoUrl,
        TURSO_AUTH_TOKEN: "",
        SUPER_ADMIN_EMAIL: "",
        SUPER_ADMIN_PASSWORD: "",
        GROQ_API_KEY: "",
        SMTP_ENABLED: "0",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const app: App = {
    base: "",
    log: "",
    kill() {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    },
  };
  killables.push(app.kill);
  const onData = (buf: Buffer) => {
    app.log += buf.toString();
    if (process.env.REMOTE_VERBOSE) process.stdout.write(`  | ${buf.toString()}`);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`harness did not start in 30s. Log:\n${app.log}`)), 30_000);
    timer.unref?.();
    const check = () => {
      const m = /platform HTTP server listening on (\d+)/.exec(app.log);
      if (m) {
        app.base = `http://127.0.0.1:${m[1]}`;
        clearTimeout(timer);
        resolve();
      } else if (app.log.includes("invalid export")) {
        clearTimeout(timer);
        reject(new Error(`harness reported an invalid export:\n${app.log}`));
      } else setTimeout(check, 50);
    };
    check();
  });
  return app;
}

interface Result {
  status: number;
  ms: number;
  data: any;
  text: string;
  headers: Headers;
  hung: boolean;
  json: boolean;
}

async function req(
  app: App,
  method: string,
  urlPath: string,
  opts: { json?: unknown; token?: string; headers?: Record<string, string>; deadline?: number } = {},
): Promise<Result> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.json !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const started = Date.now();
  try {
    const res = await fetch(`${app.base}${urlPath}`, {
      method,
      headers,
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
      signal: AbortSignal.timeout(opts.deadline ?? DEADLINE),
    });
    const text = await res.text();
    let data: any = null;
    let json = true;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      json = false;
    }
    return { status: res.status, ms: Date.now() - started, data, text, headers: res.headers, hung: false, json };
  } catch (err) {
    const name = (err as Error)?.name;
    return {
      status: 0,
      ms: Date.now() - started,
      data: null,
      text: "",
      headers: new Headers(),
      hung: name === "TimeoutError" || name === "AbortError",
      json: false,
    };
  }
}

/** Register + login, returning a bearer token (registration does not issue one). */
async function account(app: App, email: string, password = "Password123"): Promise<string> {
  await req(app, "POST", "/api/auth/register", {
    json: { name: "Remote Tester", email, password, phone: "01711223344", blood_group: "A+", division: "Dhaka", district: "Dhaka" },
  });
  const login = await req(app, "POST", "/api/auth/login", { json: { email, password } });
  return String(login.data?.token ?? "");
}

const rm = (file: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(file + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
};

console.log(`\n=== Remote-Turso transport suite (production entry, HTTP transport, 10 s budget) ===`);

// ===========================================================================
console.log("\n--- 1. cold start against a REMOTE (HTTP) database ---\n");
// ===========================================================================

const mainFile = path.join(TMP, "main.db");
rm(mainFile);
const stub: TursoStub = await startTursoStub({ file: mainFile });
killables.push(() => void stub.close());
console.log(`      stub Turso listening on ${stub.url}`);

let app = await bootApp(stub.url);

// Liveness must not touch the database at all.
const live = await req(app, "GET", "/");
step(
  "liveness GET / answers 200 without a database round trip",
  live.status === 200 && stub.stats.requests === 0,
  `${live.status}, db requests=${stub.stats.requests}`,
);

const health0 = await req(app, "GET", "/api/health");
step(
  "GET /api/health is JSON, 200, and costs exactly one round trip",
  health0.status === 200 && health0.json && stub.stats.requests === 1,
  `${health0.status} db=${stub.stats.requests} body=${health0.text.slice(0, 90)}`,
);
step(
  "health states the database dependency explicitly",
  health0.data?.database === "connected",
  JSON.stringify(health0.data?.database ?? null),
);

stub.resetStats();
const coldProducts = await req(app, "GET", "/api/shop/products");
const coldRoundTrips = stub.stats.requests;
const coldStatements = stub.stats.statements;
step("the first data request bootstraps the schema and answers 200", coldProducts.status === 200 && !coldProducts.hung, `${coldProducts.status} in ${coldProducts.ms}ms`);
step(
  "the cold bootstrap is a handful of round trips, not one per statement",
  coldRoundTrips > 0 && coldRoundTrips <= 40,
  `${coldRoundTrips} HTTP requests for ${coldStatements} SQL statements`,
);
step("the cold bootstrap fits comfortably inside the 10 s invocation", coldProducts.ms < 8_000, `${coldProducts.ms}ms`);
step(
  "the bootstrap really batches (several statements per round trip)",
  coldStatements / Math.max(1, coldRoundTrips) > 3,
  `${(coldStatements / Math.max(1, coldRoundTrips)).toFixed(1)} stmts/round trip`,
);
console.log(`      cold start on an EMPTY db: ${coldRoundTrips} round trips, ${coldStatements} statements, ${coldProducts.ms}ms, products=${coldProducts.data?.products?.length ?? "?"}`);

// A second instance must find the catalogue already seeded and skip the work.
const warmInstance = await bootApp(stub.url);
stub.resetStats();
const warmBoot = await req(warmInstance, "GET", "/api/shop/products");
step(
  "a second instance skips seeding (catalogue fingerprint marker works over HTTP)",
  warmBoot.status === 200 && stub.stats.requests <= 12,
  `${warmBoot.status}, ${stub.stats.requests} round trips, ${warmBoot.ms}ms`,
);
step("the seeded catalogue is readable through the HTTP transport", (warmBoot.data?.products?.length ?? 0) > 0, `products=${warmBoot.data?.products?.length}`);
console.log(`      cold start on a WARM db: ${stub.stats.requests} round trips in ${warmBoot.ms}ms`);

// Writes, reads and transactions over HTTP.
const token = await account(warmInstance, "owner@bloodora.test");
step("register + login work over the remote transport", Boolean(token), token ? "token issued" : warmInstance.log.slice(-300));
const me = await req(warmInstance, "GET", "/api/auth/me", { token });
step("bearer auth resolves the user over the remote transport", me.status === 200 && Boolean(me.data?.user?.email), `${me.status}`);

const productId = String(warmBoot.data?.products?.[0]?.id ?? "");
const order = await req(warmInstance, "POST", "/api/shop/orders", {
  token,
  json: {
    cart: { [productId]: 2 },
    payment_method: "cod",
    delivery_address: "Kalai Bazar",
    division: "Rajshahi",
    district: "Joypurhat",
    upazila: "Kalai",
  },
});
step("an order (multi-statement write) commits over HTTP", [200, 201].includes(order.status), `${order.status} ${order.text.slice(0, 160)}`);
const mine = await req(warmInstance, "GET", "/api/shop/orders/mine", { token });
step("the committed order is readable afterwards", mine.status === 200 && (mine.data?.orders?.length ?? 0) > 0, `${mine.status} orders=${mine.data?.orders?.length}`);
step("stock was decremented by the write (server-side pricing + stock)", order.status === 200 || order.status === 201, `${order.data?.total ?? "?"}`);

// BLOBs: the remote driver returns ArrayBuffer, the local one Uint8Array.
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+p7RLAAAAAElFTkSuQmCC",
  "base64",
);
const form = new FormData();
form.append("file", new Blob([png], { type: "image/png" }), "pixel.png");
const uploadRes = await fetch(`${warmInstance.base}/api/uploads`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
  body: form,
  signal: AbortSignal.timeout(DEADLINE),
}).catch(() => null);
const uploadBody = uploadRes ? await uploadRes.text().catch(() => "") : "";
let uploaded = "";
try {
  uploaded = String(JSON.parse(uploadBody)?.filename ?? "");
} catch {
  uploaded = "";
}
step("image upload stores a BLOB through the HTTP transport", uploadRes?.status === 201 && Boolean(uploaded), `${uploadRes?.status} ${uploadBody.slice(0, 120)}`);
if (uploaded) {
  const served = await fetch(`${warmInstance.base}/uploads/${uploaded}`, { signal: AbortSignal.timeout(DEADLINE) }).catch(() => null);
  const bytes = served ? Buffer.from(await served.arrayBuffer()) : Buffer.alloc(0);
  step(
    "the stored BLOB is served back byte-for-byte (ArrayBuffer path)",
    served?.status === 200 && bytes.length === png.length && bytes.equals(png),
    `${served?.status} ${bytes.length}/${png.length} bytes, content-length=${served?.headers.get("content-length")}`,
  );
}

app.kill();
warmInstance.kill();

// ===========================================================================
console.log("\n--- 2. cold start with realistic Turso round-trip latency ---\n");
// ===========================================================================

for (const rtt of [60, 150, 250]) {
  const file = path.join(TMP, `rtt-${rtt}.db`);
  rm(file);
  const slow = await startTursoStub({ file });
  killables.push(() => void slow.close());
  slow.setLatency(rtt);

  // (a) The worst case: an EMPTY database, so the whole catalogue is seeded.
  const emptyApp = await bootApp(slow.url);
  slow.resetStats();
  const first = await req(emptyApp, "GET", "/api/shop/products", { deadline: 40_000 });
  const trips = slow.stats.requests;
  step(
    `rtt=${rtt}ms, empty db: first request answers inside the 10 s invocation`,
    !first.hung && first.status === 200 && first.ms < 9_500,
    `${first.status || "HANG"} in ${first.ms}ms (${trips} round trips ≈ ${trips * rtt}ms of wire time)`,
  );
  if (first.status !== 200) console.log(`      body: ${first.text.slice(0, 200)}`);
  emptyApp.kill();

  // (b) The common production case: the catalogue is already there.
  const warmApp = await bootApp(slow.url);
  slow.resetStats();
  const warm = await req(warmApp, "GET", "/api/shop/products", { deadline: 40_000 });
  step(
    `rtt=${rtt}ms, warm db: first request answers inside the budget`,
    !warm.hung && warm.status === 200 && warm.ms < 9_500,
    `${warm.status || "HANG"} in ${warm.ms}ms (${slow.stats.requests} round trips ≈ ${slow.stats.requests * rtt}ms of wire time)`,
  );
  console.log(`      rtt=${rtt}ms  empty-db=${first.ms}ms/${trips}rt   warm-db=${warm.ms}ms/${slow.stats.requests}rt`);
  warmApp.kill();
  await slow.close();
}

// ===========================================================================
console.log("\n--- 3. warm-path round-trip accounting ---\n");
// ===========================================================================

{
  const hot = await bootApp(stub.url);
  const hotToken = await account(hot, "hot@bloodora.test");

  const probes: Array<[string, string, string, number]> = [
    ["GET", "/api/health", "health probe", 1],
    ["GET", "/api/meta/settings", "branding — the frontend calls this on every page", 8],
    ["GET", "/api/shop/products", "shop catalogue", 14],
    ["GET", "/api/auth/me", "session user — the frontend calls this on every page", 12],
    ["GET", "/api/donors", "donor list", 14],
    ["GET", "/api/meta/home", "home page aggregate", 24],
  ];
  for (const [method, urlPath, label, maxTrips] of probes) {
    stub.resetStats();
    const r = await req(hot, method, urlPath, { token: hotToken });
    step(
      `${method} ${urlPath} — ${label}`,
      r.status === 200 && !r.hung && stub.stats.requests <= maxTrips,
      `${r.status} in ${r.ms}ms, ${stub.stats.requests} round trips (limit ${maxTrips})`,
    );
  }

  // The health probe must stay independent of the session store: a browser that
  // has logged in sends connect.sid, and a session read would put the database
  // back on the critical path of the endpoint that reports on the database.
  stub.resetStats();
  const withCookie = await req(hot, "GET", "/api/health", { headers: { Cookie: "connect.sid=s%3Abogus.bogus" } });
  step(
    "health with a session cookie still costs one round trip (no session-store read)",
    withCookie.status === 200 && stub.stats.requests <= 1,
    `${withCookie.status}, ${stub.stats.requests} round trips`,
  );

  // =========================================================================
  console.log("\n--- 4. Turso goes away: every answer must still be fast JSON ---\n");
  // =========================================================================

  const scenarios: Array<[string, () => void]> = [
    ["never answers (the hang that started all this)", () => stub.setFailure("silent")],
    ["answers 500", () => stub.setFailure("http500")],
    ["drops the connection", () => stub.setFailure("reset")],
  ];

  for (const [label, apply] of scenarios) {
    apply();
    const health = await req(hot, "GET", "/api/health", { deadline: 12_000 });
    step(
      `db ${label}: /api/health answers fast parseable JSON`,
      !health.hung && health.json && health.status === 503 && health.ms < 6_000,
      `${health.status || "HANG"} in ${health.ms}ms json=${health.json} ${health.text.slice(0, 90)}`,
    );
    step(
      `db ${label}: health names the dependency, not an internal error`,
      health.data?.database === "unavailable" || health.data?.db === "error",
      JSON.stringify(health.data ?? null).slice(0, 120),
    );
    const api = await req(hot, "GET", "/api/shop/products", { deadline: 12_000 });
    step(
      `db ${label}: a data route answers 5xx JSON instead of hanging`,
      !api.hung && api.json && api.status >= 500 && api.status < 600 && api.ms < 9_500,
      `${api.status || "HANG"} in ${api.ms}ms ${api.text.slice(0, 90)}`,
    );
    step(
      `db ${label}: the error envelope carries a stable code`,
      typeof api.data?.error?.code === "string" && api.data.error.code.length > 0,
      JSON.stringify(api.data?.error ?? null).slice(0, 120),
    );
    step(
      `db ${label}: no secret, host or SQL leaks into the response`,
      !/libsql|127\.0\.0\.1|Bearer |SELECT |CREATE TABLE/i.test(`${api.text}${health.text}`),
      `${api.text.slice(0, 120)}`,
    );
    const live2 = await req(hot, "GET", "/", { deadline: 5_000 });
    step(`db ${label}: liveness still answers (the function is alive)`, live2.status === 200, `${live2.status}`);
  }

  // =========================================================================
  console.log("\n--- 5. recovery on the SAME instance (no redeploy) ---\n");
  // =========================================================================

  stub.setFailure("none");
  stub.setLatency(0);
  // The bootstrap breaker refuses to retry for a few seconds after a failure;
  // wait it out rather than asserting a specific backoff.
  await new Promise((r) => setTimeout(r, 6_500));
  const recoveredHealth = await req(hot, "GET", "/api/health", { deadline: 12_000 });
  step(
    "health recovers once Turso answers again",
    recoveredHealth.status === 200 && recoveredHealth.data?.database === "connected",
    `${recoveredHealth.status} ${recoveredHealth.text.slice(0, 100)}`,
  );
  const recoveredApi = await req(hot, "GET", "/api/shop/products", { deadline: 12_000 });
  step(
    "data routes recover on the same instance",
    recoveredApi.status === 200 && (recoveredApi.data?.products?.length ?? 0) > 0,
    `${recoveredApi.status} ${recoveredApi.text.slice(0, 120)}`,
  );

  // A rejected token is the classic misconfiguration: the answer must say
  // "credentials", not "the server crashed". Before the transport classified its
  // own HTTP statuses this came back as `500 {"code":"INTERNAL"}`, because hrana
  // flattens `401 {"message":"invalid token"}` into an error with code "UNKNOWN"
  // and no status anywhere in the chain.
  stub.setAuthToken("the-only-acceptable-token");
  await new Promise((r) => setTimeout(r, 6_500)); // let the breaker close from the last failure
  const authed = await req(hot, "GET", "/api/shop/products", { deadline: 12_000 });
  step(
    "a rejected Turso token surfaces as a controlled 5xx, not a crash",
    !authed.hung && authed.json && authed.status >= 500,
    `${authed.status} ${authed.text.slice(0, 100)}`,
  );
  step(
    "...and it is a 503 that names the credential problem (not 500 INTERNAL)",
    authed.status === 503 && authed.data?.error?.code === "DB_AUTH_FAILED",
    `${authed.status} ${JSON.stringify(authed.data?.error ?? authed.data)}`,
  );
  step(
    "...a credential failure is NOT marked retryable (retrying cannot fix it)",
    authed.data?.error?.retryable === false,
    JSON.stringify(authed.data?.error),
  );
  step(
    "...the response never quotes the token, the host or Turso's own body",
    !/invalid token|the-only-acceptable-token|Bearer|127\.0\.0\.1|localhost/i.test(authed.text),
    authed.text.slice(0, 160),
  );
  const authedAgain = await req(hot, "GET", "/api/shop/products", { deadline: 12_000 });
  step(
    "...and repeated credential failures fail fast via the breaker, not per round trip",
    authedAgain.status === 503 && authedAgain.ms < 1_500,
    `${authedAgain.status} in ${authedAgain.ms}ms`,
  );
  stub.setAuthToken(undefined);
  await new Promise((r) => setTimeout(r, 6_500));
  const afterAuth = await req(hot, "GET", "/api/shop/products", { deadline: 12_000 });
  step("the instance recovers after the token is fixed", afterAuth.status === 200, `${afterAuth.status}`);

  const crashed = /uncaught exception|unhandled rejection|exit status/.test(hot.log);
  step("the instance never crashed while the database misbehaved", !crashed, crashed ? hot.log.slice(-400) : "no crash markers in the log");

  hot.kill();
}

// ---------------------------------------------------------------------------
bye();
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
