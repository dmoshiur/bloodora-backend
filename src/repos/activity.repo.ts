import { get, all, run } from "../db/query.js";
import { randomId } from "../utils/errors.js";
import type { ActivityRow } from "../types.js";

export const activityRepo = {
  async create(type: string, userId: string | null, message: string, meta?: Record<string, unknown> | null): Promise<void> {
    await run(
      `INSERT INTO activities (id, type, user_id, message, meta) VALUES (?, ?, ?, ?, ?)`,
      [randomId(), type, userId, message, meta ? JSON.stringify(meta) : null],
    );
  },

  async list(limit = 30, offset = 0): Promise<ActivityRow[]> {
    return all<ActivityRow>(`SELECT * FROM activities ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [limit, offset]);
  },

  async count(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities`);
    return row?.n ?? 0;
  },

  async prune(keep = 500): Promise<number> {
    const { changes } = await run(
      `DELETE FROM activities WHERE id NOT IN (SELECT id FROM activities ORDER BY created_at DESC LIMIT ?)`,
      [keep],
    );
    return changes;
  },
};
