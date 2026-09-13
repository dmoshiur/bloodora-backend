import { get, all, run } from "../db/query.js";

export const settingsRepo = {
  async get(key: string): Promise<string | null> {
    const row = await get<{ value: string | null }>(`SELECT value FROM settings WHERE key = ?`, [key]);
    return row?.value ?? null;
  },

  async set(key: string, value: string | null): Promise<void> {
    await run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  },

  async setMany(values: Record<string, string | null>): Promise<void> {
    for (const [k, v] of Object.entries(values)) {
      await this.set(k, v);
    }
  },

  async all(): Promise<Record<string, string>> {
    const rows = await all<{ key: string; value: string | null }>(`SELECT key, value FROM settings`);
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value ?? "";
    return out;
  },
};
