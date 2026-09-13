import { get, all, run } from "../db/query.js";
import type { ProductRow } from "../types.js";

export const productRepo = {
  async findById(id: string): Promise<ProductRow | null> {
    return get<ProductRow>(`SELECT * FROM products WHERE id = ?`, [id]);
  },

  async findBySlug(slug: string): Promise<ProductRow | null> {
    return get<ProductRow>(`SELECT * FROM products WHERE slug = ?`, [slug]);
  },

  async list(opts: { category?: string; search?: string; limit?: number; offset?: number } = {}): Promise<ProductRow[]> {
    const { category, search, limit = 100, offset = 0 } = opts;
    let sql = `SELECT * FROM products WHERE is_active = 1`;
    const args: unknown[] = [];
    if (category) {
      sql += ` AND category = ?`;
      args.push(category);
    }
    if (search) {
      const like = `%${search}%`;
      sql += ` AND (name LIKE ? OR description LIKE ?)`;
      args.push(like, like);
    }
    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    args.push(limit, offset);
    return all<ProductRow>(sql, args);
  },

  async count(opts: { category?: string; search?: string } = {}): Promise<number> {
    const { category, search } = opts;
    let sql = `SELECT COUNT(*) AS n FROM products WHERE is_active = 1`;
    const args: unknown[] = [];
    if (category) { sql += ` AND category = ?`; args.push(category); }
    if (search) {
      const like = `%${search}%`;
      sql += ` AND (name LIKE ? OR description LIKE ?)`;
      args.push(like, like);
    }
    const row = await get<{ n: number }>(sql, args);
    return row?.n ?? 0;
  },

  async categories(): Promise<{ category: string; count: number }[]> {
    return all<{ category: string; count: number }>(
      `SELECT category, COUNT(*) AS count FROM products
       WHERE is_active = 1 AND category IS NOT NULL
       GROUP BY category ORDER BY category`,
    );
  },

  async all(): Promise<ProductRow[]> {
    return all<ProductRow>(`SELECT * FROM products ORDER BY created_at`);
  },

  async create(row: Omit<ProductRow, "created_at">): Promise<void> {
    await run(
      `INSERT INTO products
        (id, slug, name, price, stock, category, description, image_file, is_active, sales_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.slug, row.name, row.price, row.stock, row.category, row.description, row.image_file, row.is_active, row.sales_count ?? 0],
    );
  },

  async update(id: string, fields: Partial<Omit<ProductRow, "id" | "created_at">>): Promise<void> {
    await run(
      `UPDATE products SET
         slug = COALESCE(?, slug),
         name = COALESCE(?, name),
         price = COALESCE(?, price),
         stock = COALESCE(?, stock),
         category = COALESCE(?, category),
         description = COALESCE(?, description),
         image_file = COALESCE(?, image_file),
         is_active = COALESCE(?, is_active)
       WHERE id = ?`,
      [fields.slug ?? null, fields.name ?? null, fields.price ?? null, fields.stock ?? null, fields.category ?? null, fields.description ?? null, fields.image_file ?? null, fields.is_active ?? null, id],
    );
  },

  async adjustStock(id: string, delta: number): Promise<number> {
    const before = await get<ProductRow>(`SELECT stock FROM products WHERE id = ?`, [id]);
    if (!before) return 0;
    const next = Math.max(0, before.stock + delta);
    await run(`UPDATE products SET stock = ? WHERE id = ?`, [next, id]);
    return next;
  },

  async incSales(id: string, qty: number): Promise<void> {
    await run(`UPDATE products SET sales_count = sales_count + ? WHERE id = ?`, [qty, id]);
  },

  async delete(id: string): Promise<void> {
    await run(`DELETE FROM products WHERE id = ?`, [id]);
  },

  async countAll(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM products`);
    return row?.n ?? 0;
  },

  async countLowStock(threshold = 5): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM products WHERE stock > 0 AND stock <= ?`, [threshold]);
    return row?.n ?? 0;
  },

  async countOutOfStock(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM products WHERE stock = 0`);
    return row?.n ?? 0;
  },

  async lowStock(threshold = 5, limit = 20): Promise<ProductRow[]> {
    return all<ProductRow>(
      `SELECT * FROM products WHERE stock <= ? ORDER BY stock ASC LIMIT ?`,
      [threshold, limit],
    );
  },

  async bestSellers(limit = 10): Promise<ProductRow[]> {
    return all<ProductRow>(`SELECT * FROM products WHERE is_active = 1 ORDER BY sales_count DESC, price DESC LIMIT ?`, [limit]);
  },
};
