import { get, all, run } from "../db/query.js";
import type { UploadRow } from "../types.js";

export const uploadRepo = {
  async findByFilename(filename: string): Promise<UploadRow | null> {
    return get<UploadRow>(`SELECT * FROM uploads WHERE filename = ?`, [filename]);
  },

  async insert(id: string, filename: string, originalName: string | null, mime: string, data: Uint8Array): Promise<void> {
    await run(
      `INSERT INTO uploads (id, filename, original_name, mime, size, data) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(filename) DO UPDATE SET data = excluded.data, size = excluded.size, mime = excluded.mime`,
      [id, filename, originalName, mime, data.length, data],
    );
  },

  async delete(filename: string): Promise<void> {
    await run(`DELETE FROM uploads WHERE filename = ?`, [filename]);
  },

  async pruneOrphans(keep: string[], olderThanDays = 1): Promise<number> {
    if (keep.length === 0) return 0;
    const marks = keep.map(() => `?`).join(",");
    const { changes } = await run(
      `DELETE FROM uploads WHERE filename NOT IN (${marks}) AND created_at < datetime('now', ?)`,
      [...keep, `-${olderThanDays} days`],
    );
    return changes;
  },
};
