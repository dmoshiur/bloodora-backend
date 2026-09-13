import { createClient, type Client } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { timedFetch } from "./timeout.js";

let client: Client | null = null;

/** True when the client talks to a remote Turso/libSQL host over HTTP(S). */
export function isRemote(): boolean {
  return Boolean(config.tursoDatabaseUrl);
}

/**
 * Single shared libSQL client per instance. `createClient` handles both
 * remote `libsql://` URLs (stateless HTTP to Turso) and local `file:`
 * databases (dev only). No request data is held in memory.
 *
 * Reuse matters twice over on serverless: the client is created at most once per
 * warm instance, and — for the remote path — its `fetch` carries an
 * `AbortController` deadline. Without that deadline the HTTP transport can wait
 * on a socket forever: `@libsql/client` implements **no** timeout internally
 * (verified — zero `AbortSignal`/`setTimeout` references in its http/node/web
 * transports), so an unreachable Turso host turned every request into an
 * infinite hang.
 */
export function getClient(): Client {
  if (client) return client;

  if (config.tursoDatabaseUrl) {
    client = createClient({
      url: config.tursoDatabaseUrl,
      authToken: config.tursoAuthToken || undefined,
      intMode: "number",
      // Bound the transport itself, not just the await on top of it. This is the
      // only hook libSQL exposes for a network deadline.
      fetch: timedFetch(config.dbTimeoutMs, "Turso request"),
    });
    // Host + scheme only — never the auth token, which lives in the URL for some
    // Turso configurations and must not reach the logs.
    logger.info("database: using remote Turso client", {
      host: safeHost(config.tursoDatabaseUrl),
      timeoutMs: config.dbTimeoutMs,
    });
  } else {
    if (config.isProd) {
      throw new Error(
        "Production requires TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (an in-process file database is not acceptable for serverless).",
      );
    }
    const file = path.resolve(process.cwd(), "data", "local.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    client = createClient({ url: `file:${file}`, intMode: "number" });
    logger.info("database: using local libSQL file (dev only)", { file });
  }
  return client;
}

/** Log-safe view of a database URL: scheme + host, with any credentials dropped. */
function safeHost(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "<unparseable url>";
  }
}

export function closeClient(): void {
  if (client) {
    client.close();
    client = null;
  }
}
