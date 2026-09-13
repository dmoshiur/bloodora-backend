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

  jwtSecret: string;
  jwtTtlDays: number;
  cookieDomain: string;
  cookieSecure: boolean;

  frontendOrigins: string[];

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

  const config: Config = {
    nodeEnv,
    isProd,
    port: int(env.PORT, 4000),
    logLevel: env.LOG_LEVEL || "info",
    tursoDatabaseUrl: env.TURSO_DATABASE_URL || "",
    tursoAuthToken: env.TURSO_AUTH_TOKEN || "",
    jwtSecret: env.JWT_SECRET || "",
    jwtTtlDays: int(env.JWT_TTL_DAYS, 7),
    cookieDomain: env.COOKIE_DOMAIN || "",
    cookieSecure: isProd ? true : bool(env.COOKIE_SECURE, false),
    frontendOrigins,
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
