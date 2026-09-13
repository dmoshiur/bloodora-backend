import { all, get, run } from "../db/query.js";
import { nowIso } from "../utils/time.js";
import { randomId } from "../utils/errors.js";

/**
 * Navigation manager.
 *
 * The site's navigation/page catalogue used to be a frozen array in
 * `src/data/content.ts`: adding, hiding or reordering an entry meant a deploy,
 * and the AI assistant's knowledge base could drift from the real site.
 * It now lives in the database — seeded once from that same array so
 * `GET /api/meta/routes` returns byte-for-byte the shape the frontend (and the
 * AI prompt builder) already consumes, then editable at runtime.
 *
 * `path` is UNIQUE: two entries pointing at the same URL would render a
 * duplicated nav link and confuse the AI's route lookup.
 */

export interface NavigationRow {
  id: string;
  label: string;
  path: string;
  title: string | null;
  purpose: string | null;
  keywords: string | null;
  area: string;
  section: string;
  icon: string | null;
  position: number;
  is_active: number;
  requires_auth: number;
  requires_admin: number;
  created_at: string;
  updated_at: string;
}

export interface NewNavigation {
  label: string;
  path: string;
  title?: string | null;
  purpose?: string | null;
  keywords?: string[] | string | null;
  area?: string;
  section?: string;
  icon?: string | null;
  position?: number;
  isActive?: boolean;
  requiresAuth?: boolean;
  requiresAdmin?: boolean;
}

export function keywordsToString(v: string[] | string | null | undefined): string | null {
  if (Array.isArray(v)) return JSON.stringify(v);
  if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

/** `keywords` is stored as JSON when seeded from the catalogue, plain text otherwise. */
export function parseKeywords(raw: string | null): string[] {
  if (!raw) return [];
  const t = raw.trim();
  if (t.startsWith("[")) {
    try {
      const arr = JSON.parse(t) as unknown;
      return Array.isArray(arr) ? arr.map(String) : [];
    } catch {
      return [];
    }
  }
  return t.split(",").map((s) => s.trim()).filter(Boolean);
}

export const navigationRepo = {
  async list(opts: { area?: string; activeOnly?: boolean } = {}): Promise<NavigationRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.area) {
      where.push("area = ?");
      args.push(opts.area);
    }
    if (opts.activeOnly) where.push("is_active = 1");
    return all<NavigationRow>(
      `SELECT * FROM navigation${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
       ORDER BY position ASC, rowid ASC`,
      args,
    );
  },

  async findById(id: string): Promise<NavigationRow | null> {
    return get<NavigationRow>(`SELECT * FROM navigation WHERE id = ?`, [id]);
  },

  async findByPath(path: string): Promise<NavigationRow | null> {
    return get<NavigationRow>(`SELECT * FROM navigation WHERE path = ?`, [path]);
  },

  async count(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM navigation`);
    return row?.n ?? 0;
  },

  async create(input: NewNavigation): Promise<NavigationRow> {
    const id = randomId();
    const at = nowIso();
    const position = input.position ?? (await this.nextPosition(input.area ?? "public"));
    await run(
      `INSERT INTO navigation
         (id, label, path, title, purpose, keywords, area, section, icon, position, is_active, requires_auth, requires_admin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.label.slice(0, 80),
        input.path,
        input.title ?? null,
        input.purpose ?? null,
        keywordsToString(input.keywords),
        input.area ?? "public",
        input.section ?? "main",
        input.icon ?? null,
        position,
        input.isActive === false ? 0 : 1,
        input.requiresAuth ? 1 : 0,
        input.requiresAdmin ? 1 : 0,
        at,
        at,
      ],
    );
    return (await this.findById(id))!;
  },

  async update(id: string, fields: Partial<NewNavigation>): Promise<void> {
    await run(
      `UPDATE navigation SET
         label = COALESCE(?, label),
         path = COALESCE(?, path),
         title = COALESCE(?, title),
         purpose = COALESCE(?, purpose),
         keywords = COALESCE(?, keywords),
         area = COALESCE(?, area),
         section = COALESCE(?, section),
         icon = COALESCE(?, icon),
         position = COALESCE(?, position),
         is_active = COALESCE(?, is_active),
         requires_auth = COALESCE(?, requires_auth),
         requires_admin = COALESCE(?, requires_admin),
         updated_at = ?
       WHERE id = ?`,
      [
        fields.label ? String(fields.label).slice(0, 80) : null,
        fields.path ?? null,
        fields.title ?? null,
        fields.purpose ?? null,
        fields.keywords === undefined ? null : keywordsToString(fields.keywords),
        fields.area ?? null,
        fields.section ?? null,
        fields.icon ?? null,
        fields.position ?? null,
        fields.isActive === undefined ? null : fields.isActive ? 1 : 0,
        fields.requiresAuth === undefined ? null : fields.requiresAuth ? 1 : 0,
        fields.requiresAdmin === undefined ? null : fields.requiresAdmin ? 1 : 0,
        nowIso(),
        id,
      ],
    );
  },

  async delete(id: string): Promise<void> {
    await run(`DELETE FROM navigation WHERE id = ?`, [id]);
  },

  async setPosition(id: string, position: number): Promise<void> {
    await run(`UPDATE navigation SET position = ?, updated_at = ? WHERE id = ?`, [position, nowIso(), id]);
  },

  /**
   * Persist a full ordering in one pass. Positions are written from the array
   * index so the client never has to compute gaps, and a repeated id is ignored
   * after its first appearance (a drag-and-drop UI can send duplicates).
   */
  async reorder(ids: string[]): Promise<number> {
    const seen = new Set<string>();
    let written = 0;
    for (const [index, id] of ids.entries()) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const { changes } = await run(`UPDATE navigation SET position = ?, updated_at = ? WHERE id = ?`, [
        index,
        nowIso(),
        id,
      ]);
      written += changes > 0 ? 1 : 0;
    }
    return written;
  },

  async nextPosition(area: string): Promise<number> {
    const row = await get<{ m: number | null }>(`SELECT MAX(position) AS m FROM navigation WHERE area = ?`, [area]);
    return (row?.m ?? -1) + 1;
  },
};
