/**
 * Vercel-function harness.
 *
 * Imports the REAL serverless entry (`api/index.ts`) and lets the *platform* own
 * the HTTP socket — the module only exports a handler, exactly as on Vercel.
 * Used by `tests/production.e2e.mts`; not a test itself.
 *
 * It also asserts the two properties whose absence produced the original
 * FUNCTION_INVOCATION_FAILED: importing the entry must not open a port, must not
 * touch the database, and must yield a callable function.
 */
import http from "node:http";

const port = Number(process.env.HARNESS_PORT || 4100);
const importStarted = Date.now();
const mod = (await import("../api/index.js")) as { default?: unknown; handler?: unknown };
const importMs = Date.now() - importStarted;
const handler = (mod.default ?? mod.handler) as ((req: unknown, res: unknown) => void) | undefined;

if (typeof handler !== "function") {
  console.error(`[HARNESS] invalid export: default is ${typeof handler} — Vercel would reject this function`);
  process.exit(1);
}

console.log(`[HARNESS] entry imported in ${importMs}ms; export is ${typeof handler}`);

// `port` may be 0 ("pick a free one"), so report the port actually bound — the
// runner reads it back to build its base URL.
/**
 * Vercel's edge terminates TLS and forwards every request to the function over
 * plain HTTP with `x-forwarded-proto: https`. Reproducing that here is not
 * cosmetic: `app.set("trust proxy", 1)` + `cookie.secure = true` means
 * express-session REFUSES to emit the session cookie when the request does not
 * look secure (`issecure()` in express-session/index.js). A harness that omits
 * the header would "prove" login is broken when the real platform is fine.
 */
const server = http.createServer((req, res) => {
  req.headers["x-forwarded-proto"] = req.headers["x-forwarded-proto"] || "https";
  req.headers["x-forwarded-for"] = req.headers["x-forwarded-for"] || "203.0.113.7";
  handler(req, res);
});
server.listen(port, "0.0.0.0", () => {
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  console.log(`[HARNESS] platform HTTP server listening on ${bound}`);
});
