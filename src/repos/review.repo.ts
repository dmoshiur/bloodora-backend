import { get, all, run } from "../db/query.js";
import type { ReviewRow } from "../types.js";

const REVIEWS_JOIN = `
  FROM reviews r
  LEFT JOIN users u ON r.user_id = u.id
  LEFT JOIN products p ON r.product_id = p.id
`;

export const reviewRepo = {
  async create(row: Omit<ReviewRow, "created_at">): Promise<void> {
    await run(
      `INSERT INTO reviews (id, product_id, user_id, author_name, kind, rating, title, body, status, is_approved, is_featured)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.product_id, row.user_id, row.author_name, row.kind, row.rating,
        row.title, row.body, row.status, row.status === "approved" ? 1 : 0, row.is_featured ? 1 : 0,
      ],
    );
  },

  async byProduct(productId: string, approvedOnly = true): Promise<ReviewRow[]> {
    const sql = approvedOnly
      ? `SELECT r.* FROM reviews r WHERE r.product_id = ? AND r.status = 'approved' ORDER BY r.created_at DESC LIMIT 50`
      : `SELECT r.* FROM reviews r WHERE r.product_id = ? ORDER BY r.created_at DESC LIMIT 100`;
    return all<ReviewRow>(sql, [productId]);
  },

  async pending(limit = 100): Promise<ReviewRow[]> {
    return all<ReviewRow>(`SELECT * FROM reviews WHERE status = 'pending' ORDER BY created_at DESC LIMIT ?`, [limit]);
  },

  /** Moderation queue with optional status filter (pending|approved|rejected|all). */
  async listByStatus(status: string | null, limit = 100): Promise<(ReviewRow & { user_name: string | null; user_email: string | null; product_name: string | null })[]> {
    let sql = `SELECT r.*, u.name AS user_name, u.email AS user_email, p.name AS product_name ${REVIEWS_JOIN}`;
    const args: unknown[] = [];
    if (status && status !== "all") {
      sql += ` WHERE r.status = ?`;
      args.push(status);
    }
    sql += ` ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC LIMIT ?`;
    args.push(limit);
    return all(sql, args);
  },

  async counts(): Promise<{ pending: number; approved: number; rejected: number }> {
    const rows = await all<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM reviews GROUP BY status`);
    const out = { pending: 0, approved: 0, rejected: 0 };
    for (const r of rows) if (r.status in out) out[r.status as keyof typeof out] = r.n;
    return out;
  },

  /** Public feed: approved reviews, newest first. */
  async approvedRecent(opts: { kind?: string; productId?: string; rating?: number; limit?: number } = {}): Promise<ReviewRow[]> {
    const where: string[] = ["status = 'approved'"];
    const args: unknown[] = [];
    if (opts.kind) {
      where.push("kind = ?");
      args.push(opts.kind);
    }
    if (opts.productId) {
      where.push("product_id = ?");
      args.push(opts.productId);
    }
    if (opts.rating && opts.rating > 0) {
      where.push("rating = ?");
      args.push(opts.rating);
    }
    const limit = Math.min(100, opts.limit ?? 50);
    return all<ReviewRow>(`SELECT * FROM reviews WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`, [
      ...args,
      limit,
    ]);
  },

  async approvedSummary(kind?: string): Promise<{ count: number; average: number; breakdown: Record<string, number> }> {
    const rows = await all<{ rating: number; n: number }>(
      kind
        ? `SELECT rating, COUNT(*) AS n FROM reviews WHERE status = 'approved' AND kind = ? GROUP BY rating`
        : `SELECT rating, COUNT(*) AS n FROM reviews WHERE status = 'approved' GROUP BY rating`,
      kind ? [kind] : [],
    );
    const count = rows.reduce((s, r) => s + r.n, 0);
    const total = rows.reduce((s, r) => s + r.n * r.rating, 0);
    const breakdown: Record<string, number> = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    for (const r of rows) breakdown[String(r.rating)] = r.n;
    return { count, average: count ? Math.round((total / count) * 10) / 10 : 0, breakdown };
  },

  /** Duplicate guard: same target (product or site) reviewed within the last day. */
  async recentDuplicate(userId: string, productId: string | null): Promise<ReviewRow | null> {
    return get<ReviewRow>(
      `SELECT * FROM reviews
       WHERE user_id = ? AND (product_id IS ? OR product_id = ?) AND created_at > datetime('now', '-1 day')
       LIMIT 1`,
      [userId, productId, productId],
    );
  },

  async byUser(userId: string): Promise<(ReviewRow & { product_name: string | null })[]> {
    return all(
      `SELECT r.*, p.name AS product_name FROM reviews r LEFT JOIN products p ON r.product_id = p.id
       WHERE r.user_id = ? ORDER BY r.created_at DESC`,
      [userId],
    );
  },

  async setStatus(id: string, status: string): Promise<void> {
    await run(`UPDATE reviews SET status = ?, is_approved = ? WHERE id = ?`, [status, status === "approved" ? 1 : 0, id]);
  },

  async setFeatured(id: string, featured: boolean): Promise<void> {
    await run(`UPDATE reviews SET is_featured = ? WHERE id = ?`, [featured ? 1 : 0, id]);
  },

  async setAdminReply(id: string, reply: string): Promise<void> {
    await run(`UPDATE reviews SET admin_reply = ?, admin_replied_at = datetime('now') WHERE id = ?`, [reply, id]);
  },

  async findByUserAndProduct(userId: string, productId: string): Promise<ReviewRow | null> {
    return get<ReviewRow>(`SELECT * FROM reviews WHERE user_id = ? AND product_id = ? ORDER BY created_at DESC LIMIT 1`, [userId, productId]);
  },

  async findById(id: string): Promise<ReviewRow | null> {
    return get<ReviewRow>(`SELECT * FROM reviews WHERE id = ?`, [id]);
  },

  async delete(id: string): Promise<void> {
    await run(`DELETE FROM reviews WHERE id = ?`, [id]);
  },

  async countAll(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM reviews`);
    return row?.n ?? 0;
  },

  async avgRating(productId: string): Promise<number | null> {
    const row = await get<{ a: number | null }>(
      `SELECT AVG(rating) AS a FROM reviews WHERE product_id = ? AND status = 'approved'`,
      [productId],
    );
    return row?.a != null ? Number(row.a) : null;
  },
};
