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
  const rawFrontend = env.FRONTEND_URL || "http://localhost:3000";
  const frontendOrigins = rawFrontend
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (frontendOrigins.length === 0) {
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
    if (!config.frontendOrigins.includes(env.FRONTEND_URL!)) missing.push("FRONTEND_URL");
    if (missing.length > 0) {
      throw new Error(`Production environment is missing required variables: ${missing.join(", ")}`);
    }
  } else if (!config.jwtSecret) {
    // Dev convenience only: without a JWT_SECRET, jsonwebtoken refuses to
    // sign ("secretOrPrivateKey must have a value") and every login 500s.
    // Use an ephemeral secret so `npm run dev` works out of the box; sessions
    // won't survive a restart (as expected in dev).
    config.jwtSecret = crypto.randomBytes(32).toString("hex");
    logger.warn("auth: JWT_SECRET not set — using an ephemeral dev secret (tokens die on restart)");
  }

  return config;
}

// Build once at module load. Throws fast (with a readable message) when
// production is misconfigured — better than failing per-request.
export const config: Config = build();
