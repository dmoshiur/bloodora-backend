import express from "express";
import cors from "cors";
import * as helmetExports from "helmet";
import type { HelmetOptions } from "helmet";
import morgan from "morgan";
import session from "express-session";
import { config } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { ensureDbReady } from "./db/init.js";
import { TursoSessionStore } from "./sessions/tursoStore.js";
import { languageMiddleware } from "./middleware/language.js";
import apiRouter from "./routes/index.js";
import { serveUpload } from "./controllers/upload.controller.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { requestTimeout } from "./middleware/requestTimeout.js";
import { requestContext } from "./middleware/requestId.js";
import { responseEnvelope } from "./middleware/envelope.js";
import { ah } from "./utils/async.js";

/**
 * helmet publishes dual ESM/CJS builds (`index.mjs` + `index.cjs`) and exports
 * the middleware ONLY as a default export — there is no named `helmet` export to
 * fall back on (checked against helmet 7.2.0). WHICH declaration a compiler picks
 * depends on its resolution mode, and the two disagree about what `default` is:
 *
 *   - this repo's tsconfig (`module`/`moduleResolution: NodeNext`) takes the ESM
 *     `index.d.mts` → `default` is the callable middleware;
 *   - a CJS-oriented compile (Vercel's `@vercel/node` function step resolves the
 *     `require` condition → `index.d.cts`) models `default` as the whole
 *     `module.exports` namespace, which is NOT callable:
 *
 *       src/app.ts: error TS2349: This expression is not callable.
 *         Type 'typeof import(".../node_modules/helmet/index")'
 *         has no call signatures.
 *
 * Reaching for the member through a cast only relocates that failure, because the
 * CJS shape is self-referential (`module.exports.default === module.exports`), so
 * the compiler sees `default` as the namespace again and refuses the assertion:
 *
 *       src/app.ts: error TS2352: Conversion of type
 *         'typeof import(".../node_modules/helmet/index")' to type
 *         '{ default?: HelmetMiddleware | undefined; }' may be a mistake …
 *         Types of property 'default' are incompatible.
 *
 * So stop asking the type system which shape it picked and ask the VALUE at
 * runtime — every build hands back the same function somewhere:
 *
 *   - ESM build / Node's CJS-interop → `default` is the function;
 *   - CJS build (`module.exports = exports.default;` then
 *     `module.exports.default = module.exports`) → `default` is the function;
 *   - `require`-style interop (no synthetic default) → the namespace object the
 *     import produced IS the function itself.
 *
 * `typeof x === "function"` selects whichever one is present, and routing through
 * `unknown` keeps the compiler from re-deriving a shape it may be wrong about.
 * Options stay fully typed through helmet's own `HelmetOptions`.
 */
type HelmetMiddleware = (options?: Readonly<HelmetOptions>) => express.RequestHandler;

const helmet: HelmetMiddleware = (() => {
  const ns = helmetExports as unknown as Record<string, unknown>;
  const resolved = [ns.default, ns.helmet, ns].find(
    (candidate): candidate is HelmetMiddleware => typeof candidate === "function",
  );
  if (typeof resolved !== "function") {
    // Never reached with a real helmet install; keeps a broken/partial one legible
    // instead of dying later as "helmet is not a function" inside createApp().
    throw new Error("helmet: resolved module is not callable (expected a default-exported middleware)");
  }
  return resolved;
})();

/**
 * Paths that must be answerable without touching Turso, the session store or the
 * language settings — i.e. the platform's liveness probes and the health check.
 *
 * Matching on the *original* URL only (never a rewritten/mounted path) keeps this
 * honest: it is exactly what the client asked for.
 */
export function isProbePath(req: { path?: string; originalUrl?: string; url?: string }): boolean {
  const url = String(req.originalUrl ?? req.url ?? "").split("?")[0];
  return url === "/" || url === "/health" || url === "/api/health" || url === "/favicon.ico" || url === "/favicon.png" || url.endsWith("/health");
}

function createApp(): express.Express {
  const bootStarted = Date.now();
  const stage = (msg: string, fields?: Record<string, unknown>) =>
    logger.info(`[BOOT] ${msg}`, { ...(fields ?? {}), sinceStartMs: Date.now() - bootStarted });

  stage("loading configuration", {
    env: config.nodeEnv,
    origins: config.frontendOrigins.length,
    db: config.tursoDatabaseUrl ? "remote" : "local-file",
  });

  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind Vercel's edge / LBs

  // Correlation ID first: every log line and every response header below it needs
  // the ID to exist already (see middleware/requestId.ts).
  app.use(requestContext);

  // One response shape (`ok: true|false`) applied centrally, before any handler
  // can write a body (see middleware/envelope.ts).
  app.use(responseEnvelope);

  // Outer failsafe + request accounting. Mounted before the routes so every
  // request — including the probes — is logged and bounded; see
  // middleware/requestTimeout.ts.
  app.use(requestTimeout);

  // Platform probes and browser asset requests must never depend on Turso,
  // sessions, or any other external service. Keep these routes before all
  // potentially asynchronous middleware so a cold Vercel invocation always
  // gets a fast response (and favicon probes cannot consume the timeout).
  const liveness = (_req: express.Request, res: express.Response) => {
    res.json({
      name: "bloodora-backend",
      service: "bloodora-backend",
      status: "ok",
      health: "/api/health",
    });
  };
  app.get(["/", "/health"], liveness);
  app.get(["/favicon.ico", "/favicon.png"], (_req, res) => res.status(204).end());

  stage("registering middleware");

  // Structured HTTP access logs (request line only — no bodies, no cookies).
  app.use(
    morgan("combined", {
      stream: { write: (msg: string) => logger.debug("http", { line: msg.trim() }) },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: false, // the frontend is a separate origin; no HTML is served here
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" }, // allow /uploads images cross-origin
    }),
  );

  // CORS: ONLY configured frontend origins, with credentials (cookies).
  const allowed = new Set(config.frontendOrigins.map((o) => o.toLowerCase()));
  app.use(
    cors({
      origin(origin, callback) {
        // curl / server-to-server / same-origin have no Origin header → allow.
        if (!origin || allowed.has(String(origin).toLowerCase())) {
          callback(null, true);
          return;
        }
        callback(
          Object.assign(new Error("Origin not allowed by CORS"), {
            status: 403,
            code: "CORS_NOT_ALLOWED",
          }),
        );
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true, limit: "2mb" }));

  // Persistent sessions — Turso-backed store, never MemoryStore.
  //
  // Wrapped so the probes bypass it entirely. express-session runs BEFORE the
  // router, and for any request carrying a `connect.sid` cookie it calls
  // `store.get()` — a database read. That put Turso back on the critical path of
  // `GET /api/health` for every browser that had ever logged in, which is exactly
  // the dependency the probe exists to report on. Skipping it for probes also
  // removes the last way the health check could stall on the session store.
  const sessionMiddleware = session({
    name: "connect.sid",
    store: new TursoSessionStore(),
    secret: config.jwtSecret || "dev-session-secret",
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "lax",
      domain: config.cookieDomain || undefined,
      maxAge: config.jwtTtlDays * 24 * 3600 * 1000,
    },
  });
  app.use((req, res, next) => {
    if (isProbePath(req)) {
      next();
      return;
    }
    sessionMiddleware(req, res, next);
  });

  // Every data API call (and stored-file serve) needs the DB ready exactly once.
  // Liveness endpoints intentionally bypass bootstrap: they must still answer
  // when the app process is up but Turso is unavailable, making a failed
  // deployment distinguishable from a dead function.
  //
  // Note: dbReady is mounted as `app.use("/api", dbReady, apiRouter)`, so for
  // a request to `/api/health` Express reports `req.path === "/api/health"`
  // (and `req.originalUrl === "/api/health"`). The earlier check for
  // `req.path === "/health"` therefore never matched the real health probe,
  // causing every `/api/health` request to pay the DB init cost and to fail
  // with 503 when Turso is down — exactly the opposite of what the probe is
  // for. Accept both forms.
  const dbReady = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (isProbePath(req)) {
      next();
      return;
    }
    ensureDbReady()
      .then(() => next())
      .catch((err) => {
        const shaped = err as { status?: number; code?: string; message?: string };
        const alreadyShaped = shaped?.status === 503 && shaped?.code === "DB_NOT_READY";
        // The breaker's rejection is already the right 503; log it once, quietly.
        // Anything else is an unexpected failure and deserves the full report.
        if (alreadyShaped) {
          logger.warn("db: not ready — answering 503", {
            path: req.originalUrl,
            error: shaped.message ?? "unknown",
          });
          next(err);
          return;
        }
        logger.error("db: init failed", {
          error: err instanceof Error ? err.message : String(err),
          path: req.originalUrl,
        });
        next(Object.assign(new Error("Database is not ready"), { status: 503, code: "DB_NOT_READY" }));
      });
  };
  // Language resolution runs after body parsing (it reads a `lang` field) and
  // after dbReady (the site default language is a settings row), but it is
  // skipped for the health probe: a probe carries neither `?lang=` nor a
  // supported Accept-Language, so it would trigger a settings read and make the
  // "is the database up?" endpoint depend on the database.
  const withLanguage = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (isProbePath(req)) {
      next();
      return;
    }
    void languageMiddleware(req, res, next);
  };

  stage("registering routes");
  app.use("/api", dbReady, withLanguage, apiRouter);
  // Root-level image serving (frontend references /uploads/<file> directly).
  // Wrapped in ah(): an unhandled async rejection here would crash the whole
  // process (Express 4 does not catch it), which is a hard DoS vector.
  app.use("/uploads", dbReady, express.Router().get("/:file", ah(serveUpload)));

  app.use(notFoundHandler);
  app.use(errorHandler);

  stage("application ready", {
    dbBootstrap: "lazy (first /api request)",
    requestTimeoutMs: config.requestTimeoutMs,
    dbTimeoutMs: config.dbTimeoutMs,
    dbBootstrapTimeoutMs: config.dbBootstrapTimeoutMs,
  });
  return app;
}

export default createApp;
