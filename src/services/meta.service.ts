import { CATEGORIES, BLOOD_GROUPS, PAYMENT_METHODS, ORDER_STATUSES } from "../data/constants.js";
import { divisions, districts, bangladeshData } from "../data/locations.js";
import {
  antidReference,
  compatibilityReference,
  resourcesReference,
  siteRoutes,
} from "../data/content.js";
import { navigationService } from "./navigation.service.js";
import { isAfter, nowIso } from "../utils/time.js";
import { all } from "../db/query.js";
import { settingsRepo } from "../repos/settings.repo.js";
import { productRepo } from "../repos/product.repo.js";
import { userRepo } from "../repos/user.repo.js";
import type { ReviewRow } from "../types.js";
import { bloodRequestRepo } from "../repos/bloodRequest.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { reviewRepo } from "../repos/review.repo.js";
import { contentRepo } from "../repos/content.repo.js";
import type { SiteSettings, SafeUser, UserRow } from "../types.js";

const BLOOD_GROUPS_SAFE = [...BLOOD_GROUPS];

function intOf(v: string | undefined, fallback: number): number {
  const n = v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function boolOf(v: string | undefined): number {
  return ["1", "true", "yes", "on"].includes((v || "").toLowerCase()) ? 1 : 0;
}

/** All settings rows as a SiteSettings (numeric/bool coercion applied). */
export async function loadSettings(): Promise<SiteSettings> {
  const db = await settingsRepo.all();
  const s = Object.fromEntries(Object.entries(db).map(([k, v]) => [k, v === "" ? null : v])) as unknown as SiteSettings;
  s.delivery_fee = intOf(db.delivery_fee, 10);
  s.free_shipping_threshold = intOf(db.free_shipping_threshold, 0);
  s.smtp_port = intOf(db.smtp_port, 587);
  s.ai_temperature = Number(db.ai_temperature) || 0.5;
  s.ai_max_tokens = intOf(db.ai_max_tokens, 900);
  s.card_enabled = boolOf(db.card_enabled);
  s.smtp_enabled = boolOf(db.smtp_enabled);
  s.smtp_secure = boolOf(db.smtp_secure);
  s.ai_enabled = boolOf(db.ai_enabled);
  s.live_chat_enabled = boolOf(db.live_chat_enabled);
  s.live_activity_enabled = boolOf(db.live_activity_enabled);
  return s;
}

export interface MetaResponse {
  site: {
    name: string;
    logo: string | null;
    footerNote: string | null;
    primaryColor: string;
    fontStyle: string;
    announcement: string | null;
    whatsapp: string | null;
    supportPhone: string | null;
    email: string | null;
    address: string | null;
    language: string;
  };
  categories: string[];
  categoryDetails: { name: string; count: number }[];
  bloodGroups: string[];
  paymentMethods: string[];
  orderStatuses: string[];
  divisions: string[];
  delivery: { areas: string[]; fee: number; freeShippingThreshold: number };
  products: { count: number; bestSellers: { id: string; slug: string; name: string; price: number; image: string | null }[] };
  ai: { enabled: boolean; model: string };
}

const EVENT_PRESENTATION: Record<string, { tone: string; icon: string; label: string }> = {
  register: { tone: "success", icon: "fa-user-plus", label: "Register" },
  login: { tone: "muted", icon: "fa-right-to-bracket", label: "Login" },
  order: { tone: "primary", icon: "fa-bag-shopping", label: "Order" },
  "blood-request": { tone: "danger", icon: "fa-droplet", label: "Blood Request" },
  donation: { tone: "success", icon: "fa-hand-holding-heart", label: "Donation" },
  review: { tone: "warning", icon: "fa-star", label: "Review" },
  message: { tone: "info", icon: "fa-envelope", label: "Message" },
  announcement: { tone: "primary", icon: "fa-bullhorn", label: "Announcement" },
  verify: { tone: "success", icon: "fa-circle-check", label: "Verification" },
};

function presentEvent(row: { id: string; type: string; message: string; meta: string | null; created_at: string }) {
  let detail: string | null = null;
  let link: string | null = null;
  if (row.meta) {
    try {
      const m = JSON.parse(row.meta) as { detail?: string; link?: string };
      detail = m.detail ?? null;
      link = m.link ?? null;
    } catch {
      /* meta is freeform; ignore parse errors */
    }
  }
  const p = EVENT_PRESENTATION[row.type] || { tone: "info", icon: "fa-circle-info", label: row.type };
  return {
    id: row.id,
    kind: row.type,
    title: row.message,
    detail,
    link,
    tone: p.tone,
    icon: `fa-${p.icon.slice(3)}`.replace(/^fa-/, "fa-"),
    label: p.label,
    created_at: row.created_at,
  };
}

export const metaService = {
  /** Original contract: GET /api/meta (kept for the consolidated view). */
  async get(): Promise<MetaResponse> {
    const settings = await loadSettings();
    const categoryRows = await productRepo.categories();
    const best = await productRepo.bestSellers(4);

    return {
      site: {
        name: settings.site_name,
        logo: settings.logo_file ? `/uploads/${settings.logo_file}` : null,
        footerNote: settings.footer_note,
        primaryColor: settings.brand_primary || settings.primary_color,
        fontStyle: settings.brand_font_style || settings.font_style,
        announcement: settings.announcement,
        whatsapp: settings.whatsapp,
        supportPhone: settings.support_phone,
        email: settings.site_email,
        address: settings.site_address,
        language: settings.default_language,
      },
      categories: CATEGORIES,
      categoryDetails: categoryRows.length
        ? categoryRows.map((r) => ({ name: r.category || "", count: r.count }))
        : [],
      bloodGroups: BLOOD_GROUPS_SAFE,
      paymentMethods: PAYMENT_METHODS,
      orderStatuses: ORDER_STATUSES,
      divisions: divisions.map((d: { id: string; name: string }) => d.name),
      delivery: {
        areas: settings.delivery_areas.split(",").map((s) => s.trim()).filter(Boolean),
        fee: settings.delivery_fee,
        freeShippingThreshold: settings.free_shipping_threshold,
      },
      products: {
        count: categoryRows.reduce((n, c) => n + c.count, 0),
        bestSellers: best.map((p) => ({
          id: p.id,
          slug: p.slug,
          name: p.name,
          price: p.price,
          image: p.image_file ? `/uploads/${p.image_file}` : null,
        })),
      },
      ai: {
        enabled: Boolean(settings.ai_api_key) && settings.ai_enabled === 1,
        model: settings.ai_model,
      },
    };
  },

  /** GET /api/meta/settings — raw settings object (original field names). */
  async settingsView() {
    return { settings: await loadSettings() };
  },

  /** GET /api/meta/home — homepage payload. */
  async home() {
    const [settings, notice, donors, urgent, recentDonors, recentRequests] = await Promise.all([
      loadSettings(),
      contentRepo.activeNotice(),
      userRepo.count(),
      bloodRequestRepo.countUrgent(),
      userRepo.listDonors({ limit: 5 }),
      bloodRequestRepo.listPublic({ limit: 5 }),
    ]);
    // `listDonors` returns raw rows, where flags are SQLite 0/1. The view
    // coerces them so the homepage payload carries real booleans (the frontend
    // only ever tests truthiness, and `!!0 === !!false`).
    const recentDonorView = (u: UserRow) => ({
      id: u.id,
      name: u.name,
      blood_group: u.blood_group,
      district: u.district,
      upazila: u.upazila,
      image_file: u.image_file,
      is_verified: Boolean(u.is_verified),
    });
    const recentRequestView = (r: { id: string; blood_group: string; units: number; district: string | null; upazila: string | null; urgent: number; created_at: string }) => ({
      id: r.id,
      blood_group: r.blood_group,
      units: r.units,
      district: r.district,
      upazila: r.upazila,
      urgent: r.urgent,
      created_at: r.created_at,
    });
    return {
      settings,
      notice: notice?.content ?? null,
      total_donors: donors,
      urgent_requests: urgent,
      recent_donors: recentDonors.map(recentDonorView),
      recent_requests: recentRequests.map(recentRequestView),
    };
  },

  /** GET /api/meta/activity — public live activity feed. */
  async activity(limit = 30) {
    const rows = await activityRepo.list(Math.min(100, Math.max(1, Number(limit) || 30)));
    return {
      events: rows.map(presentEvent),
      serverTime: new Date().toISOString(),
    };
  },

  /**
   * Rows strictly after a cursor — used by the SSE broadcaster.
   *
   * The cursor arrives as ISO-8601 from the client, but `activity.created_at`
   * is written by SQLite's `datetime('now')` default (`2026-09-13 06:49:18`).
   * The previous `r.created_at > sinceIso` string comparison was ALWAYS false
   * across those two formats, so the public activity stream connected, sent its
   * heartbeat and never emitted a single event. Comparing parsed epoch values
   * makes the cursor work regardless of which format a row was written in.
   */
  async activitySince(sinceIso: string) {
    const rows = await activityRepo.list(100);
    return rows.filter((r) => isAfter(r.created_at, sinceIso)).map(presentEvent);
  },

  /** GET /api/meta/reviews — public review feed + summary. */
  async reviews(opts: { kind?: string; productId?: string; rating?: number } = {}) {
    const [rows, summary] = await Promise.all([
      reviewRepo.approvedRecent({ kind: opts.kind, productId: opts.productId, rating: opts.rating, limit: 100 }),
      reviewRepo.approvedSummary(opts.kind),
    ]);
    return {
      reviews: await attachReviewUsers(rows),
      summary,
    };
  },

  /** GET /api/meta/antid — Anti-D reference + admin-managed entries. */
  async antid() {
    const entries = await contentRepo.listAntiD();
    return {
      reference: antidReference,
      antid_info: entries,
      entries: entries.map((e) => ({
        id: e.id,
        title: e.title,
        description: e.description,
        timing: e.timing,
        dosage: e.dosage,
        image: e.image_file ? `/uploads/${e.image_file}` : null,
      })),
    };
  },

  /** GET /api/meta/compatibility — blood compatibility chart. */
  async compatibility() {
    return { reference: compatibilityReference };
  },

  /** GET /api/meta/resources — educational resources (admin rows + built-in). */
  async resources(opts: { category?: string; q?: string } = {}) {
    const rows = await contentRepo.listResources(opts);
    const all = await contentRepo.listResources();
    const categories = [...new Set(all.map((r) => r.category).filter(Boolean))] as string[];
    return {
      resources: rows.map((r) => ({
        id: r.id,
        title: r.title,
        category: r.category,
        content: r.content,
        summary: r.summary,
        image: r.image_file ? `/uploads/${r.image_file}` : null,
        is_featured: Boolean(r.is_featured),
        source: r.source,
        read_time: Math.max(1, Math.round(r.content.length / 1200)),
        created_at: r.created_at,
      })),
      categories,
      fallback: resourcesReference,
    };
  },

  /** GET /api/meta/routes — site route catalogue (used by AI knowledge). */
  /**
   * GET /api/meta/routes — the site's page catalogue.
   *
   * Now served from the `navigation` table (seeded from the built-in
   * `siteRoutes` array, editable in Admin → Navigation) instead of the frozen
   * array in code, so hiding or renaming a page no longer needs a deploy. The
   * response shape is unchanged: `{ success, routes: [{path,title,purpose,keywords}] }`.
   */
  async routes() {
    try {
      const routes = await navigationService.routes();
      if (routes.length) return { success: true, routes };
    } catch (err) {
      // The catalogue is a convenience, never a hard dependency: a navigation
      // table problem must not take the whole meta endpoint down with it.
      console.warn("[meta] navigation lookup failed, using the built-in catalogue", err);
    }
    return { success: true, routes: siteRoutes };
  },

  /** GET /api/meta/locations — division→district→upazila tree. */
  async locations() {
    return { bangladeshData, divisions, districts };
  },
};

async function attachReviewUsers(rows: ReviewRow[]) {
  if (rows.length === 0) return [];
  const ids = [...new Set(rows.map((r) => r.user_id))];
  const marks = ids.map(() => `?`).join(",");
  const users = await all<{ id: string; name: string; image_file: string | null; is_verified: number }>(
    `SELECT id, name, image_file, is_verified FROM users WHERE id IN (${marks})`,
    ids,
  );
  const byId = new Map(users.map((u) => [u.id, u]));
  return rows.map((r) => {
    const u = byId.get(r.user_id);
    return {
      id: r.id,
      product_id: r.product_id,
      kind: r.kind,
      rating: r.rating,
      title: r.title,
      body: r.body,
      author_name: u?.name ?? "Anonymous",
      is_featured: Boolean(r.is_featured),
      admin_reply: r.admin_reply,
      created_at: r.created_at,
      user: u ? { id: u.id, name: u.name, image: u.image_file ? `/uploads/${u.image_file}` : null } : null,
      verified: Boolean(u?.is_verified),
    };
  });
}
