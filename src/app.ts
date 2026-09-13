import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import session from "express-session";
import { config } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { ensureDbReady } from "./db/init.js";
import { TursoSessionStore } from "./sessions/tursoStore.js";
import apiRouter from "./routes/index.js";
import { serveUpload } from "./controllers/upload.controller.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { ah } from "./utils/async.js";

function createApp(): express.Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", 1); // behind Vercel's edge / LBs

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

  // Every API call (and stored-file serve) needs the DB ready exactly once.
  const dbReady = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    ensureDbReady()
      .then(() => next())
      .catch((err) => {
        logger.error("db: init failed", { err: String(err) });
        next(Object.assign(new Error("Database is not ready"), { status: 503, code: "DB_NOT_READY" }));
      });
  };
  app.use("/api", dbReady, apiRouter);
  // Root-level image serving (frontend references /uploads/<file> directly).
  // Wrapped in ah(): an unhandled async rejection here would crash the whole
  // process (Express 4 does not catch it), which is a hard DoS vector.
  app.use("/uploads", dbReady, express.Router().get("/:file", ah(serveUpload)));

  app.get("/", (_req, res) => {
    res.json({ name: "bloodora-backend", status: "ok", health: "/api/health" });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
