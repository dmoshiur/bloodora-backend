import { batch } from "./query.js";
import { SEED_PRODUCTS } from "../data/products.js";
import { DEFAULT_IMAGES } from "../data/defaultImages.js";
import { randomId } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/**
 * Seed data — written so a cold start costs a handful of round trips, not one
 * per row.
 *
 * Each seeder reads the set of keys that already exist in ONE query, then writes
 * everything missing in ONE `batch()`. The previous version did a `SELECT` and an
 * `INSERT` per row (15 products + 14 images = up to 58 sequential HTTPS requests
 * against Turso) on every single cold start, which was a large share of why the
 * first request never finished inside the function's time limit.
 *
 * Large payloads are chunked so no single request carries the whole ~130 KB of
 * embedded PNG data.
 */

/** Split `items` into groups whose estimated payload stays under `maxBytes`. */
function chunkByBytes<T>(items: T[], sizeOf: (item: T) => number, maxBytes = 512 * 1024): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (current.length > 0 && bytes + size > maxBytes) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Insert default product images into the uploads table (idempotent by
 * filename). Products reference /uploads/<image_file>, and images are served
 * from the DB (serverless-safe: no filesystem). Base64 is embedded so the
 * seed has zero file-system dependency.
 */
export async function seedDefaultImages(): Promise<number> {
  const filenames = Object.keys(DEFAULT_IMAGES);
  if (filenames.length === 0) return 0;

  // One query for "which of these already exist?" instead of one per image.
  const found = await batch([
    {
      sql: `SELECT filename FROM uploads WHERE filename IN (${filenames.map(() => "?").join(",")})`,
      args: filenames,
    },
  ]);
  const existing = new Set(
    ((found[0]?.rows ?? []) as unknown as Array<{ filename: string }>).map((r) => r.filename),
  );

  const missing = Object.entries(DEFAULT_IMAGES)
    .filter(([filename]) => !existing.has(filename))
    .map(([filename, b64]) => {
      const data = Buffer.from(b64, "base64");
      return { filename, size: data.length, data };
    });
  if (missing.length === 0) return 0;

  let inserted = 0;
  for (const group of chunkByBytes(missing, (m) => m.size)) {
    await batch(
      group.map(
        (m) =>
          [
            `INSERT INTO uploads (id, filename, original_name, mime, size, data)
             VALUES (?, ?, ?, 'image/png', ?, ?)
             ON CONFLICT(filename) DO NOTHING`,
            [randomId(), m.filename, m.filename, m.size, m.data],
          ] as [string, unknown[]],
      ),
    );
    inserted += group.length;
  }
  return inserted;
}

/**
 * Insert default products (idempotent by slug). Returns how many were inserted.
 * created_at is staggered (one minute per row) so `ORDER BY created_at DESC` is
 * deterministic: seed order == listing order.
 */
export async function seedProducts(): Promise<number> {
  const total = SEED_PRODUCTS.length;
  if (total === 0) return 0;

  const slugs = SEED_PRODUCTS.map((p) => p.slug);
  const found = await batch([
    { sql: `SELECT slug FROM products WHERE slug IN (${slugs.map(() => "?").join(",")})`, args: slugs },
  ]);
  const existing = new Set(
    ((found[0]?.rows ?? []) as unknown as Array<{ slug: string }>).map((r) => r.slug),
  );

  const missing = SEED_PRODUCTS.map((p, i) => ({ p, i })).filter(({ p }) => !existing.has(p.slug));
  if (missing.length === 0) return 0;

  await batch(
    missing.map(({ p, i }) => {
      const ageMinutes = total - 1 - i; // i=0 is newest
      return [
        `INSERT INTO products
          (id, slug, name, price, stock, category, description, image_file, is_active, sales_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, datetime('now', ?))`,
        [p.id, p.slug, p.name, p.price, p.stock, p.category, p.description, p.image_file, `-${ageMinutes} minutes`],
      ] as [string, unknown[]];
    }),
  );
  logger.debug("seed: products inserted", { count: missing.length });
  return missing.length;
}
