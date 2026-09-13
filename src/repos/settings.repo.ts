import { get, all, run, batch } from "../db/query.js";

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

  /**
   * Write many keys in ONE round trip.
   *
   * This used to loop `await this.set(k, v)` — one HTTPS request per key against a
   * remote Turso database. Saving the Admin → Settings panel writes a dozen keys
   * and the AI panel writes nine, so a single "Save" cost 9-12 round trips before
   * the response could even start. Same statements, same transaction semantics,
   * one request.
   */
  async setMany(values: Record<string, string | null>): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) return;
    await batch(
      entries.map(([k, v]) => [
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [k, v],
      ]),
    );
  },

  async all(): Promise<Record<string, string>> {
    const rows = await all<{ key: string; value: string | null }>(`SELECT key, value FROM settings`);
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value ?? "";
    return out;
  },
};
