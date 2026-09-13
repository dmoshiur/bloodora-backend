#!/usr/bin/env npx tsx
/**
 * Cold-start budget benchmark.
 *
 * Measures how long the FIRST request that needs the database takes to answer,
 * as a function of Turso network RTT — the number that decides whether a
 * serverless deployment ever becomes reachable at all.
 *
 * The RTT is injected as a delay on the libSQL client's `execute`/`batch`
 * methods. That is arithmetically identical to real network latency for this
 * measurement, because the bootstrap awaits each round trip in sequence; what it
 * cannot model is TCP/TLS handshaking, which only makes the real number worse.
 *
 * Each RTT runs in its OWN child process. ESM caches modules per registry, so a
 * patched client and an unpatched app could not coexist in one process — and a
 * genuine cold start also needs a fresh module registry and an empty database.
 *
 * Baseline for comparison (measured before the batching fix, same method):
 *   RTT  20ms →   5.3s      RTT  80ms →  39.1s
 *   RTT  50ms →  18.3s      RTT 120ms →  70.3s
 * against 451 sequential round trips. Vercel Hobby's maxDuration is 10s.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// ------------------------------------------------------------------ child mode
if (process.env.BENCH_CHILD === "1") {
  const rtt = Number(process.env.BENCH_RTT || "0");

  const clientMod = await import("../src/db/client.js");
  const client = clientMod.getClient();
  const proto = Object.getPrototypeOf(client) as {
    execute: (...a: unknown[]) => Promise<unknown>;
    batch: (...a: unknown[]) => Promise<unknown>;
  };

  let trips = 0;
  let statements = 0;
  const delay = () => (rtt > 0 ? new Promise<void>((r) => setTimeout(r, rtt)) : Promise.resolve());
  const origExecute = proto.execute;
  const origBatch = proto.batch;
  proto.execute = async function patchedExecute(this: unknown, ...a: unknown[]) {
    trips += 1;
    statements += 1;
    await delay();
    return origExecute.apply(this, a as never) as Promise<unknown>;
  };
  proto.batch = async function patchedBatch(this: unknown, ...a: unknown[]) {
    trips += 1; // ONE request, however many statements it carries
    statements += Array.isArray(a[0]) ? a[0].length : 1;
    await delay();
    return origBatch.apply(this, a as never) as Promise<unknown>;
  };

  const createApp = (await import("../src/app.js")).default;
  const app = createApp();
  const server = http.createServer((req, res) => app(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const hit = async (p: string) => {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(300_000) });
    await res.text();
    return { status: res.status, ms: Date.now() - started };
  };

  // The first database-backed request pays the entire bootstrap.
  const cold = await hit("/api/meta");
  // A later request on the same warm instance reuses the memoized bootstrap.
  const warm = await hit("/api/shop/products");
  // The probe must stay fast even while the RTT is high: it is exempt from the
  // bootstrap and bounded by its own deadline.
  const health = await hit("/api/health");

  process.stdout.write(
    JSON.stringify({ rtt, trips, statements, coldMs: cold.ms, coldStatus: cold.status, warmMs: warm.ms, healthMs: health.ms, healthStatus: health.status }),
  );
  server.close();
  clientMod.closeClient();
  process.exit(0);
}

// ----------------------------------------------------------------- parent mode
const RTTS = (process.env.BENCH_RTTS || "20,50,80,120,200").split(",").map((n) => Number(n.trim()));
const BUDGET = Number(process.env.BENCH_BUDGET_MS || 10_000);

interface Row { rtt: number; trips: number; statements: number; coldMs: number; coldStatus: number; warmMs: number; healthMs: number; healthStatus: number }
const rows: Row[] = [];

for (const rtt of RTTS) {
  const dbFile = path.join(ROOT, "data", `bench-${Date.now()}-${rtt}.db`);
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.rmSync(dbFile, { force: true });

  const out = await new Promise<string>((resolve, reject) => {
    let buf = "";
    let errBuf = "";
    const child = spawn(process.execPath, [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), fileURLToPath(import.meta.url)], {
      cwd: ROOT,
      env: {
        ...process.env,
        BENCH_CHILD: "1",
        BENCH_RTT: String(rtt),
        NODE_ENV: "production",
        LOG_LEVEL: "error",
        JWT_SECRET: "bench-secret-0123456789abcdef0123456789abcdef00",
        FRONTEND_URL: "http://localhost:3000",
        TURSO_DATABASE_URL: `file:${dbFile}`,
        TURSO_AUTH_TOKEN: "unused-by-the-local-engine",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d: Buffer) => { buf += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { errBuf += d.toString(); });
    child.on("exit", (code) => (code === 0 ? resolve(buf) : reject(new Error(`rtt=${rtt} exited ${code}\n${errBuf}`))));
  });

  rows.push(JSON.parse(out.trim()) as Row);
  fs.rmSync(dbFile, { force: true });
}

console.log(`\n=== Cold-start budget (platform limit: ${BUDGET}ms) ===`);
console.log("  RTT   roundTrips  statements  firstDbRequest  warmRequest  /api/health  verdict");
let worst = 0;
let failed = false;
for (const r of rows) {
  const ok = r.coldMs <= BUDGET && r.coldStatus === 200;
  if (!ok) failed = true;
  worst = Math.max(worst, r.coldMs);
  console.log(
    `${String(r.rtt).padStart(4)}ms  ${String(r.trips).padStart(9)}  ${String(r.statements).padStart(9)}  ${String(r.coldMs).padStart(11)}ms  ${String(r.warmMs).padStart(8)}ms  ${String(r.healthMs).padStart(8)}ms  ${ok ? "✅" : "❌ EXCEEDS BUDGET"}`,
  );
}
console.log(`\nworst-case first database-backed request: ${worst}ms (budget ${BUDGET}ms)`);
process.exit(failed ? 1 : 0);
