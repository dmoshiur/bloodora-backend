#!/usr/bin/env npx tsx
/**
 * Invocation-budget regression guard.
 *
 * The production failure this file exists for:
 *
 *   504: GATEWAY_TIMEOUT   Code: FUNCTION_INVOCATION_TIMEOUT
 *
 * It was NOT a missing timeout. Every primitive already had one. It was that the
 * timeouts did not ADD UP: each was configured longer than the whole invocation,
 * and handlers chained or looped several of them.
 *
 *   POST /api/ai/chat           25 s per attempt x 2 attempts + backoff = 50.4 s
 *   POST /api/admin/mail/flush  up to 50 sequential sends x ~24 s each
 *   REQUEST_TIMEOUT_MS=55000    the outer failsafe could never fire at all
 *
 * vercel.json caps an invocation at 10 s, so the platform killed these requests
 * and answered with its own **HTML** 504. That is also why the frontend spun
 * forever: `await res.json()` throws on HTML, so a spinner cleared only on the
 * success path never cleared.
 *
 * Section 1 pins the static properties. Section 2 proves the behaviour by booting
 * the real serverless entry with a deliberately SMALL budget and a provider that
 * never answers, then requiring a JSON response before the budget expires.
 *
 * Usage: npm run test:budget
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
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

// The budget this behavioural run is booted with. Small on purpose: it proves the
// clamping is derived from the platform limit rather than hardcoded to 10 s.
const TEST_MAX_DURATION_MS = Number(process.env.BUDGET_TEST_MAX_DURATION_MS || 6000);
const PROVIDER_STALL_MS = 60_000; // never answers inside any budget we care about
const PROVIDER_FAST_MS = 80;

console.log(`=== Invocation-budget guard (test maxDuration ${TEST_MAX_DURATION_MS}ms) ===\n`);
console.log("--- 1. static: every deadline must fit inside the invocation ---");

// ---------------- vercel.json ↔ env agreement ----------------
const vc = JSON.parse(read("vercel.json"));
const platformMaxDuration = vc?.functions?.["api/index.ts"]?.maxDuration;
step("vercel.json pins maxDuration explicitly (no reliance on a plan default)", typeof platformMaxDuration === "number", String(platformMaxDuration));
step("maxDuration is deployable on Hobby (<=10s)", platformMaxDuration <= 10, String(platformMaxDuration));

const envSrc = code(read("src/config/env.ts"));
step("env.ts reads the platform limit from FUNCTION_MAX_DURATION_MS", /FUNCTION_MAX_DURATION_MS/.test(envSrc));
step("env.ts defaults FUNCTION_MAX_DURATION_MS to the value vercel.json pins", new RegExp(`int\\(env\\.FUNCTION_MAX_DURATION_MS,\\s*${platformMaxDuration}_?000\\)`).test(envSrc), `expected default ${platformMaxDuration}000`);
step("env.ts holds back a response reserve", /RESPONSE_RESERVE_MS/.test(envSrc) && /responseReserveMs/.test(envSrc));
step("the budget is maxDuration minus the reserve", /budgetMs\s*=\s*functionMaxDurationMs\s*-\s*responseReserveMs/.test(envSrc));
step("a clamp helper exists and every deadline goes through it", /const deadline = \(name: string, requested: number/.test(envSrc));
for (const knob of ["DB_TIMEOUT_MS", "DB_BATCH_TIMEOUT_MS", "DB_BOOTSTRAP_TIMEOUT_MS", "HEALTH_DB_TIMEOUT_MS", "SESSION_TIMEOUT_MS", "REQUEST_TIMEOUT_MS", "AI_TIMEOUT_MS", "SMTP_TIMEOUT_MS", "SSE_MAX_MS"]) {
  step(`${knob} is clamped to the budget`, new RegExp(`deadline\\("${knob}"`).test(envSrc));
}
step("clamped deadlines are reported at boot, not silently applied", /were clamped/.test(envSrc));
// The three that caused the outage were all longer than the invocation.
step("REQUEST_TIMEOUT_MS no longer defaults above the budget", !/REQUEST_TIMEOUT_MS,\s*55_000\)/.test(envSrc));
step("DB_BATCH_TIMEOUT_MS is clamped even though it defaults to 20s", /deadline\("DB_BATCH_TIMEOUT_MS",\s*rawDbBatchTimeoutMs\)/.test(envSrc));
step("SMTP_TIMEOUT_MS is divided across nodemailer's three stacked phases", /Math\.floor\(budgetMs \/ 3\)/.test(envSrc));

// ---------------- the request-scoped deadline ----------------
step("utils/deadline.ts exists", fs.existsSync(path.join(ROOT, "src/utils/deadline.ts")));
const dlSrc = code(read("src/utils/deadline.ts"));
step("the deadline is request-scoped via AsyncLocalStorage", /AsyncLocalStorage/.test(dlSrc));
step("remainingMs() is unbounded outside a request (CLIs, dev boot)", /POSITIVE_INFINITY/.test(dlSrc));
step("clampToRemaining() never turns a disabled (0) bound into a bound", /ms <= 0\) return ms/.test(dlSrc));
step("exhausting the budget produces a shaped 504, not a hang", /status = 504/.test(dlSrc) && /FUNCTION_BUDGET_EXHAUSTED/.test(dlSrc));

const rtSrc = code(read("src/middleware/requestTimeout.ts"));
step("the middleware establishes the deadline every layer clamps to", /runWithDeadline\(/.test(rtSrc));
step("the failsafe fires INSIDE the platform limit (grace < reserve)", /graceMs/.test(rtSrc) && /config\.requestTimeoutMs \+ graceMs/.test(rtSrc));
step("the failsafe still never writes over a streaming response", /res\.headersSent/.test(rtSrc));
step("a request with no budget still gets one (REQUEST_TIMEOUT_MS=0 is not an escape hatch on serverless)", /config\.requestTimeoutMs > 0 \? config\.requestTimeoutMs : config\.budgetMs/.test(rtSrc));

const toSrc = code(read("src/db/timeout.ts"));
step("withTimeout() clamps to the remaining request budget", /clampToRemaining\(ms\)/.test(toSrc));
step("withTimeout() fails immediately when no budget is left", /effective <= 0/.test(toSrc));
step("timedFetch() re-clamps per call (the client outlives any one request)", /clampToRemaining\(ms\)/.test(toSrc.slice(toSrc.indexOf("timedFetchImpl"))));

// ---------------- the AI loop: ONE total deadline, not one per attempt ----------------
const aiSrc = code(read("src/services/ai.service.ts"));
step("the AI service has exactly one bare fetch() — inside its timeout helper", (aiSrc.match(/await fetch\(/g) || []).length === 1, String((aiSrc.match(/await fetch\(/g) || []).length));
step("the AI provider call is bounded by a TOTAL budget", /aiBudgetMs/.test(aiSrc) && /deadlineAt/.test(aiSrc));
step("each attempt spends down the remaining total, not a fresh full timeout", /fetchWithTimeout\(\s*url,[\s\S]*?left,/.test(aiSrc));
step("an attempt too short to be worth starting is skipped", /MIN_ATTEMPT_MS/.test(aiSrc));
step("backoff sleeps cannot push the loop past the deadline", /timeLeft\(\) >= MIN_ATTEMPT_MS \+ /.test(aiSrc));
step("time is reserved to persist the turn and write the response", /AI_POST_PROCESS_RESERVE_MS/.test(aiSrc));
step("the fetch timer covers the BODY, not just the headers", /const text = await res\.text\(\);/.test(aiSrc) && !/return await fetch\(url, \{ \.\.\.init, signal: controller\.signal \}\);\s*\} finally/.test(aiSrc));
step("an infinite deadline can never reach setTimeout (Node would fire it immediately)", /Number\.isFinite\(ms\) && ms > 0 \? ms : config\.aiTimeoutMs/.test(aiSrc));
step("GET /models costs a fraction of the budget, not all of it", /MODEL_CATALOGUE_TIMEOUT_MS/.test(aiSrc) && !/Math\.min\(config\.aiTimeoutMs, 10_000\)/.test(aiSrc));

// ---------------- loops that used to multiply a bounded call ----------------
const mailSrc = code(read("src/services/email.service.ts"));
step("the outbox flush checks the budget before starting each send", /budgetExhausted\(MIN_SEND_BUDGET_MS\)/.test(mailSrc));
step("a flush that stops early says so instead of looking like a success", /stopped: "budget"/.test(mailSrc) && /skipped/.test(mailSrc));
step("the final tally cannot turn a successful flush into a 504", /safeCounts\(\)/.test(mailSrc));

const maintSrc = code(read("src/services/maintenance.service.ts"));
step("the maintenance sweep checks the budget between tasks", /budgetExhausted\(MIN_TASK_BUDGET_MS\)/.test(maintSrc));
step("skipped tasks are reported by name", /skipped\.push\(name\)/.test(maintSrc));

const smtpSrc = code(read("src/services/smtp.service.ts"));
step("a whole sendMail() is bounded, not only nodemailer's socket phases", /withTimeout\(\s*transporterFor\(s\)\.sendMail/.test(smtpSrc));
step("SMTP test does not start the send without budget for it", /budgetExhausted\(500\)/.test(smtpSrc));

// ---------------- the error path must always produce a parseable body ----------------
const errSrc = code(read("src/middleware/error.ts"));
step("errorHandler refuses to write twice (ERR_HTTP_HEADERS_SENT inside the handler is unrecoverable)", /res\.headersSent \|\| res\.writableEnded/.test(errSrc));
step("notFoundHandler refuses to write twice", /headersSent/.test(errSrc.slice(0, errSrc.indexOf("export function errorHandler"))));
step("a 504 is marked retryable so the client can recover", /retryable = true/.test(errSrc));

console.log("\n--- 2. behavioural: a stalled provider must not outlive the invocation ---");

// A fake OpenAI-compatible provider. `stall` = never answer; `fast` = answer now.
let providerMode: "stall" | "fast" = "stall";
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    void body;
    const delay = providerMode === "fast" ? PROVIDER_FAST_MS : PROVIDER_STALL_MS;
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "Visit the Donors page to request blood." } }], usage: { total_tokens: 21 }, model: "budget-test-model" }));
    }, delay);
  });
});
await new Promise<void>((r) => provider.listen(0, "127.0.0.1", r));
const providerPort = (provider.address() as { port: number }).port;

const dbFile = path.join(ROOT, "data", "budget-test.db");
fs.rmSync(dbFile, { force: true });
fs.mkdirSync(path.dirname(dbFile), { recursive: true });

// Production mode: secure cookies, strict CORS, prod env validation — the real path.
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";
process.env.FRONTEND_URL = "http://localhost:3000";
process.env.JWT_SECRET = "budget-test-secret-0123456789abcdef0123456789abcdef";
process.env.TURSO_DATABASE_URL = `file:${dbFile}`;
process.env.TURSO_AUTH_TOKEN = "unused";
process.env.SMTP_ENABLED = "0";
process.env.GROQ_API_KEY = "gsk_budget_test_key";
process.env.AI_MODEL = "budget-test-model";
process.env.FUNCTION_MAX_DURATION_MS = String(TEST_MAX_DURATION_MS);

const entry = (await import("../api/index.js")) as { default: (req: unknown, res: unknown) => void };
const app = http.createServer((req, res) => {
  req.headers["x-forwarded-proto"] = "https";
  req.headers["x-forwarded-for"] = "203.0.113.7";
  entry.default(req, res);
});
await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;

await fetch(`${base}/api/meta`).then((r) => r.text()); // warm the database

// `ai_base_url` is SEEDED into settings and getConfig() prefers the stored value
// over AI_BASE_URL — so point the stored value at the fake provider.
{
  const { run } = await import("../src/db/query.js");
  await run(`UPDATE settings SET value = ? WHERE key = 'ai_base_url'`, [`http://127.0.0.1:${providerPort}/v1`]);
  await run(`UPDATE settings SET value = ? WHERE key = 'ai_model'`, ["budget-test-model"]);
  await run(`UPDATE settings SET value = ? WHERE key = 'ai_enabled'`, ["1"]);
}

const { config } = await import("../src/config/env.js");
step(`the running app derived its budget from FUNCTION_MAX_DURATION_MS`, config.functionMaxDurationMs === TEST_MAX_DURATION_MS, `${config.functionMaxDurationMs} vs ${TEST_MAX_DURATION_MS}`);
step(`the budget leaves a response reserve`, config.budgetMs === TEST_MAX_DURATION_MS - config.responseReserveMs, `${config.budgetMs}`);
step(`REQUEST_TIMEOUT_MS was clamped into the budget`, config.requestTimeoutMs <= config.budgetMs, `${config.requestTimeoutMs} > ${config.budgetMs}`);
step(`AI_TIMEOUT_MS was clamped into the budget`, config.aiTimeoutMs <= config.budgetMs, `${config.aiTimeoutMs} > ${config.budgetMs}`);
step(`DB_BATCH_TIMEOUT_MS was clamped into the budget`, config.dbBatchTimeoutMs <= config.budgetMs, `${config.dbBatchTimeoutMs} > ${config.budgetMs}`);

async function chat(label: string) {
  const t0 = Date.now();
  let status = 0;
  let contentType = "";
  let parsed: { error?: { code?: string; retryable?: boolean }; success?: boolean; reply?: string } | null = null;
  let transportError: string | null = null;
  try {
    const res = await fetch(`${base}/api/ai/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "How do I request blood urgently?" }),
    });
    status = res.status;
    contentType = res.headers.get("content-type") || "";
    const text = await res.text();
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  } catch (e) {
    transportError = (e as Error).message;
  }
  const ms = Date.now() - t0;
  console.log(`      ${label}: ${ms}ms -> ${status || "no response"} ${contentType.split(";")[0]} ${parsed ? JSON.stringify(parsed).slice(0, 90) : ""}`);
  return { ms, status, contentType, parsed, transportError };
}

// (a) the exact production symptom: a provider that never answers.
providerMode = "stall";
const stalled = await chat("stalled provider");
step("a stalled provider answers BEFORE the platform would kill the invocation", stalled.ms < TEST_MAX_DURATION_MS, `${stalled.ms}ms >= ${TEST_MAX_DURATION_MS}ms`);
step("the answer is JSON, not the platform's HTML 504", stalled.contentType.includes("application/json"), stalled.contentType);
step("the body parses (a frontend's `await res.json()` will not throw)", stalled.parsed !== null, stalled.transportError ?? "");
step("the client is told what happened", stalled.parsed?.error?.code === "AI_TIMEOUT", String(stalled.parsed?.error?.code));
step("the client is told it may retry", stalled.parsed?.error?.retryable === true, String(stalled.parsed?.error?.retryable));
step("the socket was not held for the old 50.4s retry loop", stalled.ms < TEST_MAX_DURATION_MS, `${stalled.ms}ms`);

// (b) the happy path must still work — a fix that only makes things fail fast is
//     not a fix.
providerMode = "fast";
const fast = await chat("responsive provider");
step("a responsive provider still returns 200", fast.status === 200, String(fast.status));
step("the reply is delivered intact", typeof fast.parsed?.reply === "string" && (fast.parsed?.reply ?? "").length > 0, String(fast.parsed?.reply));
step("the happy path is fast", fast.ms < 3000, `${fast.ms}ms`);

// (c) the rest of the API must be unaffected by any of this.
for (const [label, url] of [["GET /api/health", "/api/health"], ["GET /api/meta", "/api/meta"], ["GET /api/shop/products", "/api/shop/products"]] as const) {
  const t0 = Date.now();
  const res = await fetch(base + url);
  const ms = Date.now() - t0;
  step(`${label} still answers quickly`, res.status === 200 && ms < 3000, `${res.status} in ${ms}ms`);
  await res.text();
}

console.log("\n--- 3. a handler that ignores EVERY deadline still gets a JSON answer ---");

// The AI path above proves the per-operation clamps work. This proves the last
// resort does too: a route that never calls res.end() and never awaits anything
// bounded must still be answered by the request failsafe, inside the platform
// limit, with a body the frontend can parse. Without it the client would wait on
// a socket that only the platform ever closes.
{
  const express = (await import("express")).default;
  const { requestTimeout } = await import("../src/middleware/requestTimeout.js");
  const { errorHandler } = await import("../src/middleware/error.js");

  const mini = express();
  mini.use(requestTimeout);
  mini.get("/hang", () => {
    /* deliberately never responds and never settles anything */
  });
  mini.get("/late-error", async (_req, _res, next) => {
    // Simulate a handler that keeps running AFTER the failsafe answered: its
    // eventual failure must not throw ERR_HTTP_HEADERS_SENT inside errorHandler.
    await new Promise((r) => setTimeout(r, config.requestTimeoutMs + 1200));
    next(new Error("too late"));
  });
  mini.use(errorHandler);

  const miniServer = http.createServer((req, res) => {
    req.headers["x-forwarded-proto"] = "https";
    mini(req as never, res as never);
  });
  await new Promise<void>((r) => miniServer.listen(0, "127.0.0.1", r));
  const miniBase = `http://127.0.0.1:${(miniServer.address() as { port: number }).port}`;

  const t0 = Date.now();
  const hung = await fetch(`${miniBase}/hang`);
  const hungMs = Date.now() - t0;
  const hungType = hung.headers.get("content-type") || "";
  const hungBody = (await hung.text()) as string;
  let hungParsed: { error?: { code?: string; retryable?: boolean } } | null = null;
  try { hungParsed = JSON.parse(hungBody); } catch { hungParsed = null; }
  console.log(`      hanging route: ${hungMs}ms -> ${hung.status} ${hungType.split(";")[0]} ${hungBody.slice(0, 80)}`);

  step("a handler that never responds is answered by the failsafe", hung.status === 504, String(hung.status));
  step("the failsafe answers INSIDE the platform limit", hungMs < TEST_MAX_DURATION_MS, `${hungMs}ms >= ${TEST_MAX_DURATION_MS}ms`);
  step("the failsafe answer is parseable JSON", hungType.includes("application/json") && hungParsed !== null, hungType);
  step("the failsafe names the condition", hungParsed?.error?.code === "REQUEST_TIMEOUT", String(hungParsed?.error?.code));
  step("the failsafe marks it retryable", hungParsed?.error?.retryable === true, String(hungParsed?.error?.retryable));
  step("the failsafe fires after per-operation deadlines, not before", hungMs >= config.requestTimeoutMs, `${hungMs}ms < ${config.requestTimeoutMs}ms`);

  // A late error must be swallowed, not crash the process.
  let survived = true;
  const onCrash = () => { survived = false; };
  process.once("uncaughtException", onCrash);
  const late = await fetch(`${miniBase}/late-error`);
  await late.text();
  await new Promise((r) => setTimeout(r, 1500)); // let the late handler fire
  process.removeListener("uncaughtException", onCrash);
  step("a handler that errors AFTER the failsafe answered does not crash the process", survived && late.status === 504, `${survived} / ${late.status}`);

  miniServer.close();
}

provider.close();
app.close();

console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
if (failures.length) {
  console.log("Failures:");
  failures.forEach((f) => console.log(` - ${f}`));
}
process.exitCode = failures.length === 0 ? 0 : 1;
process.exit(failures.length === 0 ? 0 : 1);
