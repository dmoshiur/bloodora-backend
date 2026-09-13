/**
 * Database CLI: `npm run db:init` | `npm run db:backup`
 *
 * db:init   — apply schema + seeds (idempotent).
 * db:backup — dump every table to data/backup-<timestamp>.json (dev utility).
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDbReady } from "./db/init.js";
import { closeClient } from "./db/client.js";
import { all, get } from "./db/query.js";
import { TABLES } from "./db/schema.js";
import { logger } from "./utils/logger.js";

async function main(): Promise<void> {
  const command = process.argv[2] || "init";

  if (command === "init") {
    await ensureDbReady();
    const users = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM users`);
    const products = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM products`);
    logger.info("db:init: done", { users: users?.n ?? 0, products: products?.n ?? 0 });
  } else if (command === "backup") {
    await ensureDbReady();
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      out[table] = await all(`SELECT * FROM ${table}`);
    }
    const dir = path.resolve(process.cwd(), "data");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    logger.info("db:backup: written", { file });
  } else {
    console.error(`Unknown command: ${command} (use init | backup)`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    logger.error("db-cli: failed", { err: String(err) });
    process.exitCode = 1;
  })
  .finally(() => closeClient());
