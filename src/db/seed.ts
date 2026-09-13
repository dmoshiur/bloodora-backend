import { run, get } from "./query.js";
import { SEED_PRODUCTS } from "../data/products.js";
import { DEFAULT_IMAGES } from "../data/defaultImages.js";
import { randomId } from "../utils/errors.js";

/**
 * Insert default product images into the uploads table (idempotent by
 * filename). Products reference /uploads/<image_file>, and images are served
 * from the DB (serverless-safe: no filesystem). Base64 is embedded so the
 * seed has zero file-system dependency.
 */
export async function seedDefaultImages(): Promise<number> {
  let inserted = 0;
  for (const [filename, b64] of Object.entries(DEFAULT_IMAGES)) {
    const existing = await get<{ id: string }>(`SELECT id FROM uploads WHERE filename = ?`, [filename]);
    if (existing) continue;
    await run(
      `INSERT INTO uploads (id, filename, original_name, mime, size, data)
       VALUES (?, ?, ?, 'image/png', ?, ?)
       ON CONFLICT(filename) DO NOTHING`,
      [randomId(), filename, filename, Buffer.from(b64, "base64").length, Buffer.from(b64, "base64")],
    );
    inserted++;
  }
  return inserted;
}

/**
 * Insert default products (idempotent by slug). Returns how many were inserted.
 * created_at is staggered (one minute per row) so `ORDER BY created_at DESC`
 * is deterministic: seed order == listing order.
 */
export async function seedProducts(): Promise<number> {
  let inserted = 0;
  const total = SEED_PRODUCTS.length;
  for (let i = 0; i < SEED_PRODUCTS.length; i++) {
    const p = SEED_PRODUCTS[i];
    const existing = await get<{ id: string }>(`SELECT id FROM products WHERE slug = ?`, [p.slug]);
    if (existing) continue;
    const ageMinutes = total - 1 - i; // i=0 is newest
    await run(
      `INSERT INTO products
        (id, slug, name, price, stock, category, description, image_file, is_active, sales_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, datetime('now', ?))`,
      [p.id, p.slug, p.name, p.price, p.stock, p.category, p.description, p.image_file, `-${ageMinutes} minutes`],
    );
    inserted++;
  }
  return inserted;
}
