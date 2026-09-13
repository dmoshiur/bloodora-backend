import { get, all, run } from "../db/query.js";
import { randomId } from "../utils/errors.js";
import type { AntiDRow, ResourceRow, SiteNoticeRow, EmailLogRow } from "../types.js";

/** Content manager tables: anti_d_info, resources, site_notice, email_log. */
export const contentRepo = {
  // ---------- anti_d_info ----------
  async listAntiD(): Promise<AntiDRow[]> {
    return all<AntiDRow>(`SELECT * FROM anti_d_info ORDER BY created_at ASC`);
  },
  async getAntiD(id: string): Promise<AntiDRow | null> {
    return get<AntiDRow>(`SELECT * FROM anti_d_info WHERE id = ?`, [id]);
  },
  async insertAntiD(row: Omit<AntiDRow, "created_at">): Promise<void> {
    await run(
      `INSERT INTO anti_d_info (id, title, description, timing, dosage, image_file) VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.title, row.description, row.timing, row.dosage, row.image_file],
    );
  },
  /** Full-row update (caller merges body with the existing row). */
  async updateAntiD(
    id: string,
    fields: Pick<AntiDRow, "title" | "description" | "timing" | "dosage">,
  ): Promise<void> {
    await run(
      `UPDATE anti_d_info SET title = ?, description = ?, timing = ?, dosage = ? WHERE id = ?`,
      [fields.title, fields.description, fields.timing, fields.dosage, id],
    );
  },
  async deleteAntiD(id: string): Promise<void> {
    await run(`DELETE FROM anti_d_info WHERE id = ?`, [id]);
  },
  async countAntiD(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM anti_d_info`);
    return row?.n ?? 0;
  },

  // ---------- resources ----------
  async listResources(opts: { category?: string; q?: string } = {}): Promise<ResourceRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.category) {
      where.push("lower(category) = lower(?)");
      args.push(opts.category);
    }
    if (opts.q) {
      where.push("(title LIKE ? OR content LIKE ?)");
      const like = `%${opts.q}%`;
      args.push(like, like);
    }
    const sql = `SELECT * FROM resources${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY is_featured DESC, created_at DESC LIMIT 200`;
    return all<ResourceRow>(sql, args);
  },
  async insertResource(row: Omit<ResourceRow, "created_at">): Promise<void> {
    await run(
      `INSERT INTO resources (id, title, category, content, summary, read_time, image_file, is_featured, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.title, row.category, row.content, row.summary, row.read_time, row.image_file, row.is_featured ? 1 : 0, row.source],
    );
  },
  /** Admin list: everything, featured first. */
  async listResourcesAll(): Promise<ResourceRow[]> {
    return all<ResourceRow>(`SELECT * FROM resources ORDER BY is_featured DESC, created_at DESC LIMIT 500`);
  },
  async getResource(id: string): Promise<ResourceRow | null> {
    return get<ResourceRow>(`SELECT * FROM resources WHERE id = ?`, [id]);
  },
  /** Full-row update (caller merges body with the existing row). */
  async updateResource(
    id: string,
    fields: Pick<ResourceRow, "title" | "category" | "content" | "summary" | "read_time" | "is_featured">,
  ): Promise<void> {
    await run(
      `UPDATE resources SET title = ?, category = ?, content = ?, summary = ?, read_time = ?, is_featured = ? WHERE id = ?`,
      [
        fields.title,
        fields.category,
        fields.content,
        fields.summary,
        fields.read_time,
        fields.is_featured ? 1 : 0,
        id,
      ],
    );
  },
  async deleteResource(id: string): Promise<void> {
    await run(`DELETE FROM resources WHERE id = ?`, [id]);
  },
  async countResources(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM resources`);
    return row?.n ?? 0;
  },

  // ---------- site_notice ----------
  async activeNotice(): Promise<SiteNoticeRow | null> {
    return get<SiteNoticeRow>(`SELECT * FROM site_notice WHERE active = 1 ORDER BY updated_at DESC LIMIT 1`);
  },
  async setNotice(content: string): Promise<void> {
    await run(
      `INSERT INTO site_notice (id, content, active, updated_at) VALUES (?, ?, 1, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      ["notice", content],
    );
    await run(`UPDATE site_notice SET active = 0 WHERE id != 'notice'`);
  },
  async clearNotice(): Promise<void> {
    await run(`UPDATE site_notice SET active = 0`);
  },

  // ---------- email_log ----------
  async logEmail(toEmail: string | null, subject: string | null, status: string, error: string | null): Promise<void> {
    await run(
      `INSERT INTO email_log (id, to_email, subject, status, error) VALUES (?, ?, ?, ?, ?)`,
      [randomId(), toEmail, subject, status, error],
    );
  },
  async recentEmailLogs(limit = 30): Promise<EmailLogRow[]> {
    return all<EmailLogRow>(`SELECT * FROM email_log ORDER BY created_at DESC LIMIT ?`, [limit]);
  },
};
