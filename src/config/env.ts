import "dotenv/config";
import crypto from "node:crypto";
import { logger } from "../utils/logger.js";

const env: Record<string, string | undefined> = process.env;

export function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function int(v: string | undefined, fallback: number): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Convert a configured frontend URL to the exact origin browsers send in the
 * Origin header. Environment variables commonly contain a trailing slash or
 * whitespace; treating those as different origins makes every browser request
 * fail CORS even though the URL is otherwise correct.
 */
export function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`FRONTEND_URL contains an invalid origin: ${value}`);
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`FRONTEND_URL must contain HTTP(S) origins only: ${value}`);
  }
  return parsed.origin.toLowerCase();
}

export interface Config {
  nodeEnv: string;
  isProd: boolean;
  port: number;
  logLevel: string;

  tursoDatabaseUrl: string;
  tursoAuthToken: string;

  /**
   * The platform's hard limit for ONE invocation, in ms.
   *
   * This MUST mirror `functions["api/index.ts"].maxDuration` in vercel.json
   * (`npm run test:budget` asserts they agree). It is read from the environment
   * rather than from the JSON file at runtime on purpose: reading files off disk
   * inside a serverless handler is exactly the kind of thing that turns a config
   * question into a failed probe.
   */
  functionMaxDurationMs: number;
  /**
   * Time held back from the budget to serialize and flush the response before
   * the platform kills the invocation. A deadline that lands exactly ON the
   * limit is a deadline that loses the race.
   */
  responseReserveMs: number;
  /**
   * `functionMaxDurationMs - responseReserveMs` — the time a request may
   * actually spend doing work. EVERY deadline below is clamped to this, which is
   * what stops "each operation is bounded" from silently adding up to "the
   * request is not".
   */
  budgetMs: number;

  /**
   * Deadlines. Every one of these exists because the thing it bounds could
   * previously block a request *forever* (see src/db/timeout.ts).
   *
   * Each is additionally CLAMPED to `budgetMs`: a deadline longer than the
   * invocation itself is not a deadline, it is a guarantee that the platform
   * answers for us (with an HTML 504 the frontend cannot parse).
   */
  /** Per single SQL statement, including its HTTP round trip. */
  dbTimeoutMs: number;
  /** Per `client.batch()` — one round trip that may carry many statements/blobs. */
  dbBatchTimeoutMs: number;
  /** The whole cold-start bootstrap a request will wait for before getting a 503. */
  dbBootstrapTimeoutMs: number;
  /** The `SELECT 1` liveness probe inside GET /api/health. */
  healthDbTimeoutMs: number;
  /** Session-store reads/writes — a stalled DB must degrade auth, not hang it. */
  sessionTimeoutMs: number;
  /** Outer bound on any single HTTP request (0 disables). */
  requestTimeoutMs: number;
  /**
   * TOTAL budget for one AI interaction, covering every attempt and backoff —
   * not a per-attempt timeout. The provider call used to be allowed 25 s per
   * attempt with 2 attempts, i.e. 50.4 s inside a 10 s function.
   */
  aiTimeoutMs: number;
  /** SMTP connect/greeting/socket limits (per phase). */
  smtpTimeoutMs: number;
  /** How long an SSE stream keeps its function alive before ending gracefully. */
  sseMaxMs: number;

  jwtSecret: string;
  jwtTtlDays: number;
  cookieDomain: string;
  cookieSecure: boolean;

  frontendOrigins: string[];
  /**
   * The first allowed origin, used as the base for links the backend puts in
   * emails (password reset, email verification). CORS keeps using the full list.
   * Empty in production when FRONTEND_URL is unset — callers must not build a
   * link from it without checking.
   */
  frontendUrl: string;

  superAdminEmail: string;
  superAdminPassword: string;
  superAdminName: string;
  superAdminPhone: string;

  /** Max size of a single uploaded image, in MB (multer `fileSize` limit). */
  maxUploadMb: number;

  aiProvider: string;
  aiModel: string;
  aiBaseUrl: string;
  groqApiKey: string;

  smtp: {
    enabled: boolean;
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    fromName: string;
    fromEmail: string;
  };
}

function build(): Config {
  const nodeEnv = env.NODE_ENV || "development";
  const isProd = nodeEnv === "production";
  const rawFrontend = env.FRONTEND_URL || (isProd ? "" : "http://localhost:3000");
  let frontendOrigins: string[] = [];
  if (rawFrontend.trim()) {
    const parts = rawFrontend
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const parsed: string[] = [];
    for (const p of parts) {
      try {
        parsed.push(normalizeOrigin(p));
      } catch (err) {
        // Keep the server alive even if one origin is malformed — log and skip
        // the bad entry instead of crashing the whole function (which would
        // surface as FUNCTION_INVOCATION_FAILED / timeout on Vercel).
        logger.warn("env: skipping invalid FRONTEND_URL entry", { entry: p, error: String(err) });
      }
    }
    frontendOrigins = parsed;
  }
  if (frontendOrigins.length === 0 && !isProd) {
    throw new Error("FRONTEND_URL must define at least one frontend origin");
  }

  // ---------------------------------------------------------------------------
  // The platform budget, and the clamp every deadline passes through.
  //
  // vercel.json pins `maxDuration: 10` (Hobby rejects anything higher), so an
  // invocation has 10 s of wall clock in total. Before this existed the app's
  // own defaults were REQUEST_TIMEOUT_MS=55000, AI_TIMEOUT_MS=25000 (x2
  // attempts) and DB_BATCH_TIMEOUT_MS=20000 — all longer than the invocation
  // they were supposed to protect. A deadline the platform reaches first is not
  // a deadline: Vercel killed the function and answered with an HTML
  // `504 FUNCTION_INVOCATION_TIMEOUT` instead of our JSON envelope.
  // ---------------------------------------------------------------------------
  const functionMaxDurationMs = Math.max(1_000, int(env.FUNCTION_MAX_DURATION_MS, 10_000));
  const responseReserveMs = Math.min(
    Math.max(0, int(env.RESPONSE_RESERVE_MS, 500)),
    Math.floor(functionMaxDurationMs / 2),
  );
  const budgetMs = functionMaxDurationMs - responseReserveMs;

  /** Any deadline that outlives the invocation is clamped into it (and logged). */
  const clamped: string[] = [];
  const deadline = (name: string, requested: number, ceiling = budgetMs): number => {
    // 0 / negative means "disabled" by this codebase's convention — respect it.
    // (Returning 0 rather than `Math.max(0, requested)` keeps a NaN from ever
    // reaching a setTimeout, where Node would coerce it to 1 and fire at once.)
    if (!Number.isFinite(requested) || requested <= 0) return Number.isFinite(requested) ? Math.max(0, requested) : 0;
    if (requested <= ceiling) return requested;
    clamped.push(`${name}: ${requested}ms -> ${ceiling}ms`);
    return ceiling;
  };

  const rawDbTimeoutMs = Math.max(0, int(env.DB_TIMEOUT_MS, 5_000));
  const rawDbBatchTimeoutMs = Math.max(0, int(env.DB_BATCH_TIMEOUT_MS, 20_000));
  const rawDbBootstrapTimeoutMs = Math.max(0, int(env.DB_BOOTSTRAP_TIMEOUT_MS, 8_000));
  const rawHealthDbTimeoutMs = Math.max(0, int(env.HEALTH_DB_TIMEOUT_MS, 1_500));
  const rawSessionTimeoutMs = Math.max(0, int(env.SESSION_TIMEOUT_MS, 3_000));
  // Unset means "use the whole budget": the outer failsafe should fire as late
  // as is still safe, never earlier than an operator asked for.
  const rawRequestTimeoutMs = env.REQUEST_TIMEOUT_MS === undefined || env.REQUEST_TIMEOUT_MS === ""
    ? budgetMs
    : Math.max(0, int(env.REQUEST_TIMEOUT_MS, budgetMs));
  const rawAiTimeoutMs = Math.max(0, int(env.AI_TIMEOUT_MS, 25_000));
  const rawSmtpTimeoutMs = Math.max(0, int(env.SMTP_TIMEOUT_MS, 8_000));
  const rawSseMaxMs = Math.max(0, int(env.SSE_MAX_MS, 9_000));

  const config: Config = {
    nodeEnv,
    isProd,
    port: int(env.PORT, 4000),
    logLevel: env.LOG_LEVEL || "info",
    tursoDatabaseUrl: env.TURSO_DATABASE_URL || "",
    tursoAuthToken: env.TURSO_AUTH_TOKEN || "",
    functionMaxDurationMs,
    responseReserveMs,
    budgetMs,
    // Deadlines — see src/db/timeout.ts for why each one is load-bearing, and
    // `deadline()` above for why each one is clamped to the invocation budget.
    // A single SQLite statement over HTTPS should land well inside 1 s; 5 s is
    // already generous and still leaves room inside a 10 s function budget.
    dbTimeoutMs: deadline("DB_TIMEOUT_MS", rawDbTimeoutMs),
    // A batch is ONE round trip but can carry every DDL statement or all 14
    // seeded PNG blobs (~170 KB), so it gets a wider bound than a statement —
    // but never a wider bound than the invocation (it was 20 s in a 10 s one).
    dbBatchTimeoutMs: deadline("DB_BATCH_TIMEOUT_MS", rawDbBatchTimeoutMs),
    // Must stay under the platform's function maxDuration, otherwise the runtime
    // kills the invocation (FUNCTION_INVOCATION_FAILED) instead of us answering.
    dbBootstrapTimeoutMs: deadline("DB_BOOTSTRAP_TIMEOUT_MS", rawDbBootstrapTimeoutMs),
    healthDbTimeoutMs: deadline("HEALTH_DB_TIMEOUT_MS", rawHealthDbTimeoutMs),
    sessionTimeoutMs: deadline("SESSION_TIMEOUT_MS", rawSessionTimeoutMs),
    // The outer failsafe. It MUST fire before the platform does, otherwise the
    // client gets Vercel's HTML 504 instead of our JSON one and can never tell a
    // slow backend from a dead one. Defaults to the whole budget when unset.
    requestTimeoutMs: deadline("REQUEST_TIMEOUT_MS", rawRequestTimeoutMs),
    // TOTAL budget for one AI interaction including retries, not per attempt.
    // The retry loop in ai.service.ts spends down against this.
    aiTimeoutMs: deadline("AI_TIMEOUT_MS", rawAiTimeoutMs),
    // nodemailer applies connectionTimeout, greetingTimeout AND socketTimeout as
    // three sequential phases, so a per-phase value of 8 s was really up to 24 s
    // for one send — and `flush()` sends up to 50 of them in a loop. Dividing the
    // budget by three keeps the phases inside it; smtp.service.ts additionally
    // bounds each send as a whole.
    smtpTimeoutMs: deadline("SMTP_TIMEOUT_MS", rawSmtpTimeoutMs, Math.floor(budgetMs / 3)),
    // An SSE stream holds its invocation open for its whole lifetime, so it has
    // to end itself before the budget runs out.
    sseMaxMs: deadline("SSE_MAX_MS", rawSseMaxMs),
    jwtSecret: env.JWT_SECRET || "",
    jwtTtlDays: int(env.JWT_TTL_DAYS, 7),
    cookieDomain: env.COOKIE_DOMAIN || "",
    cookieSecure: isProd ? true : bool(env.COOKIE_SECURE, false),
    frontendOrigins,
    frontendUrl: frontendOrigins[0] || "",
    superAdminEmail: (env.SUPER_ADMIN_EMAIL || "").trim(),
    superAdminPassword: env.SUPER_ADMIN_PASSWORD || "",
    superAdminName: env.SUPER_ADMIN_NAME || "Super Admin",
    superAdminPhone: env.SUPER_ADMIN_PHONE || "",
    aiProvider: env.AI_PROVIDER || "groq",
    aiModel: env.AI_MODEL || "qwen/qwen3.6-27b",
    aiBaseUrl: env.AI_BASE_URL || "https://api.groq.com/openai/v1",
    groqApiKey: env.GROQ_API_KEY || "",
    // Vercel rejects request bodies above 4.5 MB before Express sees them.
    // Keep the application-level limit below that platform ceiling so clients
    // receive our JSON upload error instead of an opaque platform response.
    maxUploadMb: Math.min(4, Math.max(1, int(env.MAX_UPLOAD_MB, 4))),
    smtp: {
      enabled: bool(env.SMTP_ENABLED, false),
      host: env.SMTP_HOST || "",
      port: int(env.SMTP_PORT, 587),
      secure: bool(env.SMTP_SECURE, false),
      user: env.SMTP_USER || "",
      pass: env.SMTP_PASS || "",
      fromName: env.SMTP_FROM_NAME || "BloodOra",
      fromEmail: env.SMTP_FROM_EMAIL || "no-reply@bloodora.site",
    },
  };

  if (isProd) {
    const missing: string[] = [];
    if (!config.tursoDatabaseUrl) missing.push("TURSO_DATABASE_URL");
    if (!config.tursoAuthToken) missing.push("TURSO_AUTH_TOKEN");
    if (!config.jwtSecret) missing.push("JWT_SECRET");
    // FRONTEND_URL is a comma-separated list, so checking the normalized list
    // against the raw env string incorrectly rejected every multi-origin setup
    // (and values with a harmless trailing slash).
    if (!env.FRONTEND_URL?.trim() || config.frontendOrigins.length === 0) {
      missing.push("FRONTEND_URL");
    }
    if (missing.length > 0) {
      // DO NOT throw in production: throwing at module load makes Vercel's
      // function crash before it can export a handler, surfacing as
      // FUNCTION_INVOCATION_FAILED / "Invalid export ... /var/task/server.js"
      // / "Node.js process exited with exit status: 1" and a public timeout
      // instead of a JSON error. Keep the process alive so liveness probes
      // (GET /) still answer 200 and API routes can return 503 with a
      // readable envelope. The missing vars are still logged loudly.
      logger.error(
        `Production environment is missing required variables: ${missing.join(", ")} — server will start in degraded mode (liveness answers, API routes return 503)`,
      );
      // Generate an ephemeral JWT secret so the server can still sign cookies
      // / tokens for the current instance instead of crashing on every auth
      // attempt. Tokens will not survive a restart, which is acceptable for a
      // misconfigured instance and strictly better than a hard crash.
      if (!config.jwtSecret) {
        config.jwtSecret = crypto.randomBytes(32).toString("hex");
        logger.warn(
          "auth: JWT_SECRET not set in production — using ephemeral secret (tokens die on restart); set JWT_SECRET in Vercel env vars",
        );
      }
    }
  }
  if (clamped.length > 0) {
    // Loud, once, at boot: an operator who set AI_TIMEOUT_MS=25000 needs to see
    // that it was reduced, and why, rather than debugging a "timeout that
    // doesn't match my env var".
    logger.warn(
      `env: ${clamped.length} deadline(s) exceeded the ${functionMaxDurationMs}ms function budget and were clamped (raise FUNCTION_MAX_DURATION_MS + vercel.json maxDuration together if the work genuinely needs longer)`,
      { budgetMs, clamped },
    );
  }
  logger.info("env: request budget", {
    functionMaxDurationMs,
    responseReserveMs,
    budgetMs,
    requestTimeoutMs: config.requestTimeoutMs,
    aiTimeoutMs: config.aiTimeoutMs,
    dbTimeoutMs: config.dbTimeoutMs,
    dbBatchTimeoutMs: config.dbBatchTimeoutMs,
    smtpTimeoutMs: config.smtpTimeoutMs,
    sseMaxMs: config.sseMaxMs,
  });

  if (!config.jwtSecret) {
    // Dev convenience only: without a JWT_SECRET, jsonwebtoken refuses to
    // sign ("secretOrPrivateKey must have a value") and every login 500s.
    // Use an ephemeral secret so `npm run dev` works out of the box; sessions
    // won't survive a restart (as expected in dev).
    config.jwtSecret = crypto.randomBytes(32).toString("hex");
    logger.warn("auth: JWT_SECRET not set — using an ephemeral dev secret (tokens die on restart)");
  }

  return config;
}

// Build once at module load. In production we NO LONGER throw for missing
// env vars — the server stays alive for liveness probes and returns 503 for
// DB-dependent routes. Throwing here would make the whole Vercel function
// crash with FUNCTION_INVOCATION_FAILED and a public timeout.
export const config: Config = build();
