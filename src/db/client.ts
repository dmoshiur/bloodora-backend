import { createClient, type Client } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

let client: Client | null = null;

/**
 * Single shared libSQL client per instance. `createClient` handles both
 * remote `libsql://` URLs (stateless HTTP to Turso) and local `file:`
 * databases (dev only). No request data is held in memory.
 */
export function getClient(): Client {
  if (client) return client;

  if (config.tursoDatabaseUrl) {
    client = createClient({
      url: config.tursoDatabaseUrl,
      authToken: config.tursoAuthToken || undefined,
      intMode: "number",
    });
    logger.info("database: using remote Turso client", { url: config.tursoDatabaseUrl.slice(0, 40) + "…" });
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

export function closeClient(): void {
  if (client) {
    client.close();
    client = null;
  }
}
