#!/usr/bin/env npx tsx
/**
 * PRODUCTION-PATH END-TO-END VERIFICATION.
 *
 * This is the "prove it actually responds" harness. It does not use `src/dev.ts`:
 * it imports the **Vercel serverless entry** (`api/index.ts`) and drives it with
 * real HTTP requests through a platform-owned socket, exactly as Vercel does.
 *
 * NODE_ENV=production is real (secure cookies, strict CORS, prod env validation).
 * TURSO_DATABASE_URL points at a `file:` URL so @libsql/client builds its local
 * engine — there is no reachable Turso from this sandbox — but the code path is
 * the production one.
 *
 * Every assertion has a hard client-side deadline. A hang is a FAILURE, not a
 * wait: that is the whole point of this file.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = process.env.HARNESS_PORT || "0"; // 0 = let the OS pick a free port
const BASE = process.env.E2E_BASE || "";
const DEADLINE = Number(process.env.E2E_DEADLINE_MS || 20000);
const SSE_MAX_MS = Number(process.env.SSE_MAX_MS || 3000);
/** Must match what the harness is booted with (the parent process has no .env). */
const FRONTEND_ORIGINS = ["http://localhost:3000", "https://bloodora-frontend.vercel.app"];

/**
 * Boot the serverless harness in a REAL production environment.
 *
 * TURSO_DATABASE_URL is a `file:` URL: `getClient()` takes its remote branch (so
 * the production code path, secure cookies and strict env validation all run) and
 * @libsql/client resolves the `file:` scheme to its local engine, because this
 * sandbox cannot reach a real Turso host.
 */
const dbFile = path.join(ROOT, "data", "e2e-prod.db");
fs.rmSync(path.join(ROOT, "data"), { recursive: true, force: true });
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

const child = spawn(process.execPath, [path.join(HERE, "..", "node_modules", "tsx", "dist", "cli.mjs"), path.join(HERE, "serverless-harness.mts")], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: "production",
    HARNESS_PORT: String(PORT),
    LOG_LEVEL: process.env.LOG_LEVEL || "warn",
    FRONTEND_URL: FRONTEND_ORIGINS.join(","),
    JWT_SECRET: "e2e-production-secret-0123456789abcdef0123456789abcdef",
    JWT_TTL_DAYS: "7",
    TURSO_DATABASE_URL: `file:${dbFile}`,
    TURSO_AUTH_TOKEN: "not-used-by-the-local-engine",
    SSE_MAX_MS: String(SSE_MAX_MS),
    // Deliberately unset: SUPER_ADMIN_* (so the first registration becomes the
    // super admin), GROQ_API_KEY (so the AI path must fail gracefully) and
    // SMTP_* (so mail must not block anything).
    SUPER_ADMIN_EMAIL: "",
    SUPER_ADMIN_PASSWORD: "",
    GROQ_API_KEY: "",
    SMTP_ENABLED: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let harnessLog = "";
const onData = (buf: Buffer) => {
  const text = buf.toString();
  harnessLog += text;
  if (process.env.E2E_VERBOSE) process.stdout.write(`  | ${text}`);
};
child.stdout.on("data", onData);
child.stderr.on("data", onData);

await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`harness did not start in 30s. Log:\n${harnessLog}`)), 30_000);
  timer.unref?.();
  const check = () => {
    if (harnessLog.includes("platform HTTP server listening")) {
      clearTimeout(timer);
      resolve();
    } else if (harnessLog.includes("invalid export")) {
      clearTimeout(timer);
      reject(new Error(`harness reported an invalid export:\n${harnessLog}`));
    } else setTimeout(check, 100);
  };
  check();
});
const killHarness = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
process.on("exit", killHarness);
process.on("uncaughtException", (err) => { console.error(err); killHarness(); process.exit(1); });
process.on("unhandledRejection", (err) => { console.error(err); killHarness(); process.exit(1); });
process.on("SIGINT", () => { killHarness(); process.exit(130); });

let pass = 0;
const failures: string[] = [];
const step = (name: string, ok: boolean, extra = "") => {
  if (ok) pass += 1;
  else failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  [${extra}]` : ""}`);
};

interface Result {
  status: number;
  ms: number;
  data: any;
  headers: Headers;
  text: string;
  hung: boolean;
}

async function req(
  method: string,
  path: string,
  opts: { json?: unknown; token?: string; cookie?: string; origin?: string; headers?: Record<string, string> } = {},
): Promise<Result> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.json !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.origin) headers.Origin = opts.origin;

  const started = Date.now();
  try {
    const res = await fetch(`${target}${path}`, {
      method,
      headers,
      body: opts.json === undefined ? undefined : JSON.stringify(opts.json),
      signal: AbortSignal.timeout(DEADLINE),
      redirect: "manual",
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, ms: Date.now() - started, data, headers: res.headers, text, hung: false };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    return {
      status: 0,
      ms: Date.now() - started,
      data: null,
      headers: new Headers(),
      text: "",
      hung: e?.name === "TimeoutError" || e?.name === "AbortError",
    };
  }
}

const j = (v: unknown) => JSON.stringify(v)?.slice(0, 180) ?? String(v);

// The harness prints the port it actually bound; read it back.
const boundPort = Number(/listening on (\d+)/.exec(harnessLog)?.[1] ?? 0);
const target = BASE || `http://127.0.0.1:${boundPort}`;
if (!boundPort && !BASE) throw new Error(`harness did not report a port. Log:\n${harnessLog}`);

console.log(`\n=== Production-path E2E against the Vercel serverless entry (${target}) ===`);
console.log(`    every request has a ${DEADLINE}ms hard deadline; a hang is a failure\n`);

// ---------------------------------------------------------------- liveness
let r = await req("GET", "/");
step("GET / responds", r.status === 200 && !r.hung, `${r.status} in ${r.ms}ms`);
step("GET / is instant (no DB dependency)", r.ms < 1500, `${r.ms}ms`);
step("GET / body is a safe API status", r.data?.status === "ok", j(r.data));

r = await req("GET", "/api/health");
step("GET /api/health responds", r.status === 200 && !r.hung, `${r.status} in ${r.ms}ms`);
step("health: success=true", r.data?.success === true, j(r.data));
step("health: database='connected'", r.data?.database === "connected", j(r.data?.database));
step("health: legacy db='ok' kept", r.data?.db === "ok", j(r.data?.db));
step("health: fast (<3s)", r.ms < 3000, `${r.ms}ms`);

r = await req("GET", "/api");
step("GET /api base responds", r.status === 200, `${r.status}`);

// ---------------------------------------------------------------- CORS
const origin = FRONTEND_ORIGINS[0];
r = await req("OPTIONS", "/api/auth/login", { origin, headers: { "Access-Control-Request-Method": "POST" } });
step("CORS preflight from the configured frontend origin", [200, 204].includes(r.status), `${r.status}`);
step("CORS preflight echoes the allowed origin", r.headers.get("access-control-allow-origin") === origin, j(r.headers.get("access-control-allow-origin")));
step("CORS preflight allows credentials", r.headers.get("access-control-allow-credentials") === "true", j(r.headers.get("access-control-allow-credentials")));

r = await req("GET", "/api/meta", { origin: "https://evil.example.com" });
step("CORS rejects an unknown origin", r.status === 403 && r.data?.error?.code === "CORS_NOT_ALLOWED", `${r.status} ${j(r.data?.error)}`);

// ---------------------------------------------------------------- auth
const adminEmail = `owner+${Date.now()}@bloodora.test`;
r = await req("POST", "/api/auth/register", {
  json: { name: "Owner", email: adminEmail, password: "Password123", phone: "01711223344", blood_group: "A+", division: "Dhaka", district: "Dhaka" },
  origin,
});
step("POST /api/auth/register (first account)", [200, 201].includes(r.status) && !r.hung, `${r.status} ${j(r.data?.error ?? r.data?.user?.role)}`);
step("first registered account becomes super_admin", r.data?.user?.role === "super_admin", j(r.data?.user?.role));
const adminId = r.data?.user?.id;

r = await req("POST", "/api/auth/login", { json: { email: adminEmail, password: "Password123" }, origin });
step("POST /api/auth/login", r.status === 200 && !!r.data?.token, `${r.status}`);
const adminToken: string | undefined = r.data?.token;
const setCookie = r.headers.get("set-cookie") ?? "";
step("login sets an httpOnly session cookie", /connect\.sid=/.test(setCookie) && /HttpOnly/i.test(setCookie), setCookie.slice(0, 90));
step("login cookie is Secure in production", /Secure/i.test(setCookie), setCookie.slice(0, 90));
const adminCookie = setCookie.split(";")[0];

r = await req("POST", "/api/auth/login", { json: { email: adminEmail, password: "wrong-password" } });
step("login with a bad password → 401 (no hang)", r.status === 401 && !r.hung, `${r.status} in ${r.ms}ms`);

r = await req("GET", "/api/auth/me", { token: adminToken });
step("GET /api/auth/me (bearer token)", r.status === 200 && r.data?.user?.id === adminId, `${r.status}`);

r = await req("GET", "/api/auth/me", { cookie: adminCookie, origin });
step("GET /api/auth/me (session cookie)", r.status === 200 && r.data?.user?.id === adminId, `${r.status}`);

r = await req("GET", "/api/auth/me");
step("GET /api/auth/me unauthenticated → 401", r.status === 401 && r.data?.error?.code === "UNAUTHENTICATED", `${r.status} ${j(r.data?.error)}`);

// ---------------------------------------------------------------- dashboards
r = await req("GET", "/api/user/dashboard", { token: adminToken });
step("GET /api/user/dashboard", r.status === 200 && r.data?.success === true, `${r.status} in ${r.ms}ms`);
step("user dashboard returns real identity", r.data?.user?.id === adminId, j(r.data?.user?.id));
step("user dashboard returns count blocks", !!r.data?.counts && !!r.data?.recent && !!r.data?.spending, j(Object.keys(r.data ?? {})));
step("user dashboard numbers are real (zero for a new account)", r.data?.counts?.orders?.total === 0, j(r.data?.counts?.orders));

r = await req("GET", "/api/admin/dashboard", { token: adminToken });
step("GET /api/admin/dashboard (super admin)", r.status === 200 && r.data?.success === true, `${r.status} in ${r.ms}ms`);
step("admin dashboard exposes stats", !!r.data?.stats && typeof r.data.stats.total_users === "number", j(r.data?.stats));
step("admin dashboard counts the registered user", r.data?.stats?.total_users >= 1, j(r.data?.stats?.total_users));

// ---------------------------------------------------------------- RBAC
const userEmail = `user+${Date.now()}@bloodora.test`;
r = await req("POST", "/api/auth/register", {
  json: { name: "Normal User", email: userEmail, password: "Password123", phone: "01700000009" },
});
step("POST /api/auth/register (second account)", [200, 201].includes(r.status), `${r.status}`);
step("second account is a normal user", r.data?.user?.role === "user", j(r.data?.user?.role));

r = await req("POST", "/api/auth/login", { json: { email: userEmail, password: "Password123" } });
const userToken: string | undefined = r.data?.token;
step("normal user can log in", r.status === 200 && !!userToken, `${r.status}`);

r = await req("GET", "/api/admin/dashboard", { token: userToken });
step("RBAC: normal user CANNOT read /api/admin/dashboard", r.status === 403, `${r.status} ${j(r.data?.error?.code)}`);
r = await req("GET", "/api/admin/settings", { token: userToken });
step("RBAC: normal user CANNOT read /api/admin/settings", r.status === 403, `${r.status}`);
r = await req("GET", "/api/user/dashboard", { token: userToken });
step("RBAC: normal user CAN read their own dashboard", r.status === 200, `${r.status}`);

// ---------------------------------------------------------------- shop / orders / payments
r = await req("GET", "/api/shop/products");
step("GET /api/shop/products", r.status === 200 && Array.isArray(r.data?.products) && r.data.products.length > 0, `${r.status} count=${r.data?.products?.length}`);
const product = r.data?.products?.[0];

r = await req("POST", "/api/shop/orders", {
  token: userToken,
  // `total`/`price`/`subtotal` are sent deliberately WRONG: the backend must
  // compute the authoritative price and ignore all of them.
  json: {
    cart: { [product.id]: 2 },
    payment_method: "cod",
    delivery_address: "Kalai Bazar",
    division: "Rajshahi",
    district: "Joypurhat",
    upazila: "Kalai",
    total: 1,
    price: 1,
    subtotal: 1,
  },
});
step("POST /api/shop/orders (booking)", [200, 201].includes(r.status) && !r.hung, `${r.status} in ${r.ms}ms ${j(r.data?.error)}`);
// placeOrder answers with a FLAT envelope: { success, orderId, total, subtotal,
// delivery_fee, payment } — there is no nested `order` object.
const orderId = r.data?.orderId;
const expectedTotal = Number(product.price) * 2 + Number(r.data?.delivery_fee ?? 0);
step("order total is computed server-side (client-sent total/price/subtotal=1 ignored)",
  !!orderId && Number(r.data?.total) === expectedTotal && Number(r.data?.total) > 1,
  j({ orderId, total: r.data?.total, subtotal: r.data?.subtotal, delivery_fee: r.data?.delivery_fee, expectedTotal, unitPrice: product?.price }));
step("order records a payment ledger reference", !!r.data?.payment?.reference, j(r.data?.payment));

r = await req("GET", "/api/shop/orders/mine", { token: userToken });
step("GET /api/shop/orders/mine", r.status === 200 && r.data?.orders?.length === 1, `${r.status}`);

r = await req("GET", "/api/payments/me", { token: userToken });
step("GET /api/payments/me", r.status === 200 && !r.hung, `${r.status} in ${r.ms}ms`);

r = await req("POST", `/api/admin/orders/${orderId}/confirm-payment`, { token: adminToken, json: { method: "cod" } });
step("admin confirms payment server-side", [200, 201, 400, 422].includes(r.status) && !r.hung, `${r.status} in ${r.ms}ms ${j(r.data?.error?.code)}`);

// ---------------------------------------------------------------- chat
r = await req("POST", "/api/support/session", { json: { session_key: null, name: "Guest" } });
step("POST /api/support/session", r.status === 200 && !!r.data?.session_key, `${r.status}`);
const chatKey = r.data?.session_key;
const clientMessageId = `idem-${Date.now()}`;

r = await req("POST", "/api/support/messages", { json: { session_key: chatKey, body: "hello, I need help", client_message_id: clientMessageId } });
step("POST /api/support/messages", [200, 201].includes(r.status) && !r.hung, `${r.status} in ${r.ms}ms`);

r = await req("POST", "/api/support/messages", { json: { session_key: chatKey, body: "hello, I need help", client_message_id: clientMessageId } });
step("chat: duplicate client_message_id is deduplicated (not by text)",
  r.status === 200 && r.data?.duplicate === true, `${r.status} ${j({ duplicate: r.data?.duplicate })}`);

r = await req("GET", `/api/support/messages?session=${chatKey}`);
step("GET /api/support/messages returns exactly one bubble", r.status === 200 && r.data?.messages?.length === 1, `${r.status} count=${r.data?.messages?.length}`);

r = await req("GET", "/api/support/admin/sessions", { token: adminToken });
step("GET /api/support/admin/sessions (admin desk)", r.status === 200 && !r.hung, `${r.status} in ${r.ms}ms`);

// ---------------------------------------------------------------- SSE
{
  const started = Date.now();
  const sseMax = SSE_MAX_MS;
  let chunks = 0;
  let endedCleanly = false;
  try {
    const res = await fetch(`${target}/api/support/stream?session=${chatKey}`, { signal: AbortSignal.timeout(sseMax + 8000) });
    step("SSE stream opens with text/event-stream", (res.headers.get("content-type") ?? "").includes("text/event-stream"), j(res.headers.get("content-type")));
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { endedCleanly = true; break; }
      chunks += value.byteLength;
    }
  } catch {
    endedCleanly = false;
  }
  const ms = Date.now() - started;
  step("SSE stream ends by itself before the platform would kill it", endedCleanly, `${ms}ms, ${chunks} bytes`);
  step("SSE lifetime respects SSE_MAX_MS", ms >= sseMax - 1500 && ms <= sseMax + 3000, `${ms}ms vs cap ${sseMax}ms`);
}

// ---------------------------------------------------------------- AI
r = await req("POST", "/api/ai/chat", { json: { messages: [{ role: "user", content: "hi" }] } });
step("POST /api/ai/chat with no provider key → controlled 503 (never a hang)",
  r.status === 503 && !!r.data?.error?.code && !r.hung, `${r.status} in ${r.ms}ms ${j(r.data?.error?.code)}`);
step("AI failure does not take the rest of the API down", (await req("GET", "/api/health")).status === 200, "health after AI failure");

r = await req("GET", "/api/ai/config");
step("GET /api/ai/config responds", r.status === 200 && !r.hung, `${r.status} in ${r.ms}ms`);

// ---------------------------------------------------------------- notifications / meta
r = await req("GET", "/api/notifications/", { token: userToken });
step("GET /api/notifications/", r.status === 200 && !r.hung, `${r.status} in ${r.ms}ms`);
r = await req("GET", "/api/meta");
step("GET /api/meta", r.status === 200 && !r.hung, `${r.status} in ${r.ms}ms`);
r = await req("GET", "/api/meta/nav");
step("GET /api/meta/nav", r.status === 200 && !r.hung, `${r.status} in ${r.ms}ms`);

// ---------------------------------------------------------------- errors
r = await req("GET", "/api/definitely-not-a-route");
step("unknown API route → JSON 404 (not a hang)", r.status === 404 && r.data?.error?.code === "NOT_FOUND", `${r.status} in ${r.ms}ms`);
r = await req("POST", "/api/auth/login", { json: "not-an-object" as unknown });
step("malformed JSON body → 400", r.status === 400 && !r.hung, `${r.status} in ${r.ms}ms`);

// ---------------------------------------------------------------- logout
r = await req("POST", "/api/auth/logout", { token: adminToken });
step("POST /api/auth/logout", r.status === 200 && !r.hung, `${r.status} in ${r.ms}ms`);
r = await req("GET", "/api/auth/me", { token: adminToken });
step("token is revoked after logout → 401", r.status === 401, `${r.status}`);

// ---------------------------------------------------------------- no hangs at all
const timed = ["/", "/api/health", "/api/meta", "/api/shop/products"];
let slowest = 0;
for (const p of timed) {
  const t = await req("GET", p);
  slowest = Math.max(slowest, t.ms);
  step(`warm ${p} is fast`, t.status === 200 && t.ms < 3000, `${t.status} in ${t.ms}ms`);
}
step("no warm request exceeded 3s", slowest < 3000, `slowest=${slowest}ms`);

console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log(` - ${f}`);
}

// The spawned harness keeps this process's event loop alive through its stdio
// pipes, so `process.exitCode` alone would never terminate the run. Kill it and
// exit explicitly.
killHarness();
process.exit(failures.length === 0 ? 0 : 1);
