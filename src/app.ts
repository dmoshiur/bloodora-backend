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

function createApp(): express.Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind Vercel's edge / LBs

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
  app.use(
    session({
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
    }),
  );

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
    const p = req.path;
    const url = req.originalUrl.split("?")[0];
    if (p === "/health" || p === "/api/health" || url === "/api/health" || url === "/health" || p.endsWith("/health")) {
      next();
      return;
    }
    ensureDbReady()
      .then(() => next())
      .catch((err) => {
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
    const url = req.originalUrl.split("?")[0];
    if (url === "/api/health" || url === "/health" || url.endsWith("/health")) {
      next();
      return;
    }
    void languageMiddleware(req, res, next);
  };

  app.use("/api", dbReady, withLanguage, apiRouter);
  // Root-level image serving (frontend references /uploads/<file> directly).
  // Wrapped in ah(): an unhandled async rejection here would crash the whole
  // process (Express 4 does not catch it), which is a hard DoS vector.
  app.use("/uploads", dbReady, express.Router().get("/:file", ah(serveUpload)));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
