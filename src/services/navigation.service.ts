import { keywordsToString, navigationRepo, parseKeywords, type NavigationRow } from "../repos/navigation.repo.js";
import { batch } from "../db/query.js";
import { nowIso } from "../utils/time.js";
import { auditRepo } from "../repos/audit.repo.js";
import { siteRoutes } from "../data/content.js";
import { ApiError, randomId } from "../utils/errors.js";
import { str, toBool } from "../utils/validate.js";
import { logger } from "../utils/logger.js";
import type { SafeUser } from "../types.js";

/**
 * Navigation management.
 *
 * `GET /api/meta/routes` has always returned the site's page catalogue — the
 * frontend uses it for navigation/SEO and the AI assistant uses it to turn a
 * mentioned page into a real link. It was a frozen array in code, so hiding,
 * adding or reordering an entry required a deploy.
 *
 * The catalogue now lives in the `navigation` table, seeded once from that same
 * array. The public response keeps its exact original shape
 * (`{ success, routes: [{ path, title, purpose, keywords }] }`) so nothing that
 * already consumes it changes, and admins gain CRUD + ordering + enable/disable.
 */

export interface RouteView {
  path: string;
  title: string;
  purpose: string;
  keywords: string[];
}

function toRouteView(row: NavigationRow): RouteView {
  return {
    path: row.path,
    title: row.title || row.label,
    purpose: row.purpose || "",
    keywords: parseKeywords(row.keywords),
  };
}

function shapeRow(row: NavigationRow) {
  return {
    id: row.id,
    label: row.label,
    path: row.path,
    title: row.title,
    purpose: row.purpose,
    keywords: parseKeywords(row.keywords),
    area: row.area,
    section: row.section,
    icon: row.icon,
    position: row.position,
    is_active: Boolean(row.is_active),
    requires_auth: Boolean(row.requires_auth),
    requires_admin: Boolean(row.requires_admin),
    updated_at: row.updated_at,
  };
}

const AREAS = ["public", "user", "admin"] as const;

/** One menu entry as a client should render it. */
export interface NavEntry {
  label: string;
  path: string;
  icon: string | null;
  section: string;
  requires_auth: boolean;
  requires_admin: boolean;
}

/** Small path→title cache for the AI link enricher (5 s, non-authoritative). */
let pathCache: { map: Map<string, string>; at: number } | null = null;

export const navigationService = {
  /** Seed the table from the built-in catalogue on an empty database. */
  /**
   * Seed the navigation catalogue from the built-in array in TWO round trips
   * (read existing paths, then insert everything missing in one batch).
   *
   * It used to be one INSERT per entry — 34 sequential HTTPS requests to Turso on
   * a cold start, on top of everything else the bootstrap did. `path` is UNIQUE,
   * so `ON CONFLICT(path) DO NOTHING` keeps the old guarantee that a duplicate in
   * the source catalogue cannot abort the bootstrap.
   */
  async ensureSeeded(): Promise<number> {
    const paths = siteRoutes.map((route) => (route as { path: string }).path);
    if (paths.length === 0) return 0;

    const found = await batch([
      { sql: `SELECT path FROM navigation WHERE path IN (${paths.map(() => "?").join(",")})`, args: paths },
    ]);
    const existing = new Set(
      ((found[0]?.rows ?? []) as unknown as Array<{ path: string }>).map((r) => r.path),
    );

    const at = nowIso();
    const writes: Array<[string, unknown[]]> = [];
    for (const [index, route] of siteRoutes.entries()) {
      const r = route as { path: string; title: string; purpose?: string; keywords?: string[] };
      if (existing.has(r.path)) continue;
      const isAdmin = r.path.startsWith("/admin") || r.path.startsWith("/shop/admin");
      const isUser = ["/donors/profile/my", "/donors/profile/edit", "/shop/my-orders", "/messages", "/messages/send"].includes(r.path);
      writes.push([
        `INSERT INTO navigation
           (id, label, path, title, purpose, keywords, area, section, icon, position, is_active, requires_auth, requires_admin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO NOTHING`,
        [
          randomId(),
          r.title.slice(0, 80),
          r.path,
          r.title ?? null,
          r.purpose ?? null,
          keywordsToString(r.keywords ?? []),
          isAdmin ? "admin" : isUser ? "user" : "public",
          isAdmin ? "admin" : "main",
          null,
          index,
          1,
          isUser || isAdmin ? 1 : 0,
          isAdmin ? 1 : 0,
          at,
          at,
        ],
      ]);
    }

    if (writes.length > 0) {
      await batch(writes);
      logger.info("navigation: seeded from the built-in catalogue", { inserted: writes.length });
      pathCache = null;
    }
    return writes.length;
  },

  /** Public catalogue — the exact shape `GET /api/meta/routes` has always returned. */
  async routes(opts: { area?: string } = {}): Promise<RouteView[]> {
    const rows = await navigationRepo.list({ activeOnly: true, area: opts.area });
    if (rows.length === 0) {
      // Unseeded/legacy database: fall back to the built-in catalogue so the
      // frontend and the AI never receive an empty site map.
      return (siteRoutes as unknown as RouteView[]).map((r) => ({ ...r, keywords: r.keywords ?? [] }));
    }
    return rows.map(toRouteView);
  },

  /** path → title lookup used to enrich links inside AI answers. */
  async pathIndex(): Promise<Map<string, string>> {
    const now = Date.now();
    if (pathCache && now - pathCache.at < 5_000) return pathCache.map;
    const rows = await navigationRepo.list({});
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.path, r.title || r.label);
    pathCache = { map, at: now };
    return map;
  },

  /**
   * Clean navigation configuration for a client: only active entries, grouped by
   * area and ordered by position. This is what a menu should render from.
   */
  async navConfig(): Promise<Record<"public" | "user" | "admin", NavEntry[]>> {
    const rows = await navigationRepo.list({ activeOnly: true });
    const pick = (area: string): NavEntry[] =>
      rows
        .filter((r) => r.area === area)
        .map((r) => ({
          label: r.label,
          path: r.path,
          icon: r.icon,
          section: r.section,
          requires_auth: Boolean(r.requires_auth),
          requires_admin: Boolean(r.requires_admin),
        }));
    return { public: pick("public"), user: pick("user"), admin: pick("admin") };
  },

  /** Admin list (includes disabled entries). */
  async list(area?: string) {
    const rows = await navigationRepo.list({ area });
    return { success: true, navigation: rows.map(shapeRow), total: rows.length, areas: [...AREAS] };
  },

  async create(actor: SafeUser, body: Record<string, unknown>, ctx: { ip?: string | null } = {}) {
    const label = str(body.label) || str(body.title);
    const path = normalizePath(str(body.path));
    if (!label) throw ApiError.badRequest("A label is required.", "LABEL_REQUIRED");
    if (!path) throw ApiError.badRequest("A path like /donors is required.", "PATH_REQUIRED");
    const existing = await navigationRepo.findByPath(path);
    if (existing) {
      // Two entries for one URL would render a duplicated link and make the AI's
      // route lookup ambiguous — refuse instead of silently overwriting.
      throw ApiError.conflict(`Navigation for ${path} already exists (id ${existing.id}).`, "NAVIGATION_PATH_TAKEN");
    }
    const area = (AREAS as readonly string[]).includes(str(body.area) || "") ? str(body.area)! : "public";
    const row = await navigationRepo.create({
      label,
      path,
      title: str(body.title) ?? label,
      purpose: str(body.purpose) ?? null,
      keywords: Array.isArray(body.keywords) ? (body.keywords as string[]) : str(body.keywords) ?? null,
      area,
      section: str(body.section) ?? "main",
      icon: str(body.icon) ?? null,
      position: body.position === undefined ? undefined : Number(body.position) || 0,
      isActive: body.is_active === undefined ? true : toBool(body.is_active, true),
      requiresAuth: toBool(body.requires_auth, false),
      requiresAdmin: toBool(body.requires_admin, false),
    });
    pathCache = null;
    await audit(actor, "navigation.create", row.id, `Added ${label} → ${path}`, { path, area }, ctx);
    return { success: true, message: `✅ “${label}” added to the navigation.`, navigation: shapeRow(row) };
  },

  async update(actor: SafeUser, id: string, body: Record<string, unknown>, ctx: { ip?: string | null } = {}) {
    const row = await navigationRepo.findById(id);
    if (!row) throw ApiError.notFound("Navigation entry not found.", "NAVIGATION_NOT_FOUND");
    const path = body.path === undefined ? undefined : normalizePath(str(body.path));
    if (path && path !== row.path) {
      const clash = await navigationRepo.findByPath(path);
      if (clash && clash.id !== id) throw ApiError.conflict(`Navigation for ${path} already exists.`, "NAVIGATION_PATH_TAKEN");
    }
    await navigationRepo.update(id, {
      ...(str(body.label) ? { label: str(body.label)! } : {}),
      ...(path ? { path } : {}),
      ...(body.title !== undefined ? { title: str(body.title) ?? null } : {}),
      ...(body.purpose !== undefined ? { purpose: str(body.purpose) ?? null } : {}),
      ...(body.keywords !== undefined
        ? { keywords: Array.isArray(body.keywords) ? (body.keywords as string[]) : str(body.keywords) ?? null }
        : {}),
      ...(str(body.area) && (AREAS as readonly string[]).includes(str(body.area)!) ? { area: str(body.area)! } : {}),
      ...(str(body.section) ? { section: str(body.section)! } : {}),
      ...(body.icon !== undefined ? { icon: str(body.icon) ?? null } : {}),
      ...(body.position === undefined ? {} : { position: Number(body.position) || 0 }),
      ...(body.is_active === undefined ? {} : { isActive: toBool(body.is_active, true) }),
      ...(body.requires_auth === undefined ? {} : { requiresAuth: toBool(body.requires_auth, false) }),
      ...(body.requires_admin === undefined ? {} : { requiresAdmin: toBool(body.requires_admin, false) }),
    });
    pathCache = null;
    const fresh = await navigationRepo.findById(id);
    await audit(actor, "navigation.update", id, `Updated ${row.label}`, { path: path ?? row.path }, ctx);
    return { success: true, message: `✅ “${fresh?.label ?? row.label}” updated.`, navigation: fresh ? shapeRow(fresh) : null };
  },

  async remove(actor: SafeUser, id: string, ctx: { ip?: string | null } = {}) {
    const row = await navigationRepo.findById(id);
    if (!row) throw ApiError.notFound("Navigation entry not found.", "NAVIGATION_NOT_FOUND");
    await navigationRepo.delete(id);
    pathCache = null;
    await audit(actor, "navigation.delete", id, `Removed ${row.label} (${row.path})`, null, ctx);
    return { success: true, message: `🗑️ “${row.label}” removed.` };
  },

  /** Enable/disable without a full update (the admin toggle). */
  async setActive(actor: SafeUser, id: string, active: boolean, ctx: { ip?: string | null } = {}) {
    const row = await navigationRepo.findById(id);
    if (!row) throw ApiError.notFound("Navigation entry not found.", "NAVIGATION_NOT_FOUND");
    await navigationRepo.update(id, { isActive: active });
    pathCache = null;
    await audit(actor, active ? "navigation.enable" : "navigation.disable", id, `${active ? "Enabled" : "Disabled"} ${row.label}`, null, ctx);
    return { success: true, message: active ? `✅ “${row.label}” is visible again.` : `🙈 “${row.label}” hidden.` };
  },

  /** Persist a new ordering: `{ order: [id, id, …] }`. */
  async reorder(actor: SafeUser, ids: unknown, ctx: { ip?: string | null } = {}) {
    const list = Array.isArray(ids) ? ids.map((v) => String(v)).filter(Boolean) : [];
    if (list.length === 0) throw ApiError.badRequest("An `order` array of navigation ids is required.", "ORDER_REQUIRED");
    const written = await navigationRepo.reorder(list);
    pathCache = null;
    await audit(actor, "navigation.reorder", null, `Reordered ${written} navigation entries`, { count: written }, ctx);
    return { success: true, message: `✅ Navigation reordered (${written} entries).`, updated: written };
  },
};

/** `/donors` stays; `http://evil.example` and `javascript:` do not. */
/**
 * Normalize an admin-supplied path.
 *
 * A missing leading slash is ADDED rather than rejected: the panel is a text
 * field, and "donors" obviously means "/donors". Everything else that could make
 * a link unusable or unsafe is still refused — an external URL, a protocol-relative
 * `//host`, a query string or a space would produce a link that navigates away
 * from the site or nowhere at all.
 */
export function normalizePath(raw: string | undefined): string | null {
  let p = (raw || "").trim();
  if (!p) return null;
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.includes("//")) return null;
  if (p.length > 200) return null;
  // Plain internal paths only: no scheme, no query, no fragment, no spaces.
  if (!/^\/[A-Za-z0-9\-_/:.]*$/.test(p)) return null;
  return p.length > 1 ? p.replace(/\/+$/, "") || "/" : "/";
}

async function audit(
  actor: SafeUser,
  action: string,
  entityId: string | null,
  summary: string,
  meta: Record<string, unknown> | null,
  ctx: { ip?: string | null },
): Promise<void> {
  await auditRepo
    .create({
      actorId: actor.id,
      actorRole: actor.role || null,
      action,
      entityType: "navigation",
      entityId,
      summary,
      meta,
      ip: ctx.ip ?? null,
    })
    .catch((err) => logger.warn("navigation: audit write failed", { err: String(err) }));
}
