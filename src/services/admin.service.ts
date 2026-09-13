import { userRepo } from "../repos/user.repo.js";
import { productRepo } from "../repos/product.repo.js";
import { orderRepo } from "../repos/order.repo.js";
import { bloodRequestRepo } from "../repos/bloodRequest.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { messageRepo } from "../repos/message.repo.js";
import { liveChatRepo } from "../repos/liveChat.repo.js";
import { contentRepo } from "../repos/content.repo.js";
import { settingsService } from "./settings.service.js";
import { loadSettings } from "./meta.service.js";
import { smtpService } from "./smtp.service.js";
import { authService } from "./auth.service.js";
import { uploadService } from "./upload.service.js";
import { ApiError } from "../utils/errors.js";
import { str } from "../utils/validate.js";
import { randomId } from "../utils/errors.js";
import { antidReference, resourcesReference } from "../data/content.js";
import bcrypt from "bcryptjs";
import type { UploadedImage } from "../uploads/uploads.js";
import type { SiteSettings, SafeUser, UserRow } from "../types.js";

const FONT_STYLES = ["calligraphic", "modern", "serif", "classic"];

function maskKey(key: string | null | undefined): string {
  return key ? "•".repeat(Math.min(String(key).length, 12)) : "";
}

/** Admin-facing settings view — secrets masked, everything else raw. */
function settingsForAdmin(s: SiteSettings) {
  const pass = s.smtp_pass || "";
  return {
    ...s,
    smtp_pass: pass ? maskKey(pass) : "",
    smtp_pass_set: Boolean(pass),
    ai_api_key: s.ai_api_key ? maskKey(s.ai_api_key) : "",
    ai_api_key_set: Boolean(s.ai_api_key),
  };
}

/** Original normalizeUser() + donation-role semantics (no secrets). */
function userView(row: UserRow) {
  const { password_hash: _p, session_token: _s, ...rest } = row;
  return {
    ...rest,
    role: row.donation_role,
    is_admin: Boolean(row.is_admin),
    is_super_admin: Boolean(row.is_super_admin),
    is_verified: Boolean(row.is_verified),
    can_donate: Boolean(row.can_donate),
  };
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function presentEvent(row: { id: string; type: string; message: string; meta: string | null; created_at: string }) {
  let detail: string | null = null;
  let link: string | null = null;
  if (row.meta) {
    try {
      const m = JSON.parse(row.meta) as { detail?: string; link?: string };
      detail = m.detail ?? null;
      link = m.link ?? null;
    } catch {
      /* ignore */
    }
  }
  return { id: row.id, kind: row.type, title: row.message, detail, link, created_at: row.created_at };
}

export const adminService = {
  // ------------------------------ dashboard ------------------------------

  /** GET /api/admin/dashboard — original contract shape. */
  async dashboard() {
    const users = await userRepo.listAll();
    const [
      totalUsers, totalDonors, admins, unreadMessages,
      pendingVerifications, urgentRequests, totalProducts,
      totalOrders, pendingOrders,
    ] = await Promise.all([
      userRepo.count(),
      userRepo.countVerifiedDonors(),
      userRepo.countByRole("admin"),
      messageRepo.unreadAdmin(),
      userRepo.countUnverified18Plus(),
      bloodRequestRepo.countUrgent(),
      productRepo.countAll(),
      orderRepo.countAll(),
      orderRepo.countByStatus("pending"),
    ]);
    const notice = await contentRepo.activeNotice();
    const settings = await loadSettings();
    return {
      success: true,
      all_users: users.map(userView),
      stats: {
        total_users: totalUsers,
        total_donors: totalDonors,
        admins,
        unread_messages: unreadMessages,
        pending_verifications: pendingVerifications,
        urgent_requests: urgentRequests,
        total_products: totalProducts,
        total_orders: totalOrders,
        pending_orders: pendingOrders,
      },
      current_notice: notice?.content || "",
      settings: settingsForAdmin(settings),
    };
  },

  // ------------------------------- settings -------------------------------

  /** GET /api/admin/settings */
  async settingsGet() {
    const settings = await loadSettings();
    return { success: true, settings: settingsForAdmin(settings) };
  },

  /** POST /api/admin/settings — `body.x || existing` merge (original). */
  async settingsPost(actor: SafeUser, body: Record<string, unknown>) {
    const existing = await loadSettings();
    const pick = (k: keyof SiteSettings) => {
      const v = body[k];
      return v == null || v === "" ? (existing[k] as string | null) ?? null : String(v);
    };
    const changes: Record<string, string | null> = {
      site_name: pick("site_name") ?? "BloodOra",
      site_email: pick("site_email"),
      site_phone: pick("site_phone"),
      site_address: pick("site_address"),
      site_description: pick("site_description"),
      facebook_url: pick("facebook_url"),
      twitter_url: pick("twitter_url"),
      instagram_url: pick("instagram_url"),
      linkedin_url: pick("linkedin_url"),
      bkash_merchant_number: pick("bkash_merchant_number"),
      nagad_merchant_number: pick("nagad_merchant_number"),
      upay_merchant_number: pick("upay_merchant_number"),
      rocket_merchant_number: pick("rocket_merchant_number"),
      pathao_merchant_number: pick("pathao_merchant_number"),
      site_tagline: body.site_tagline === undefined ? (existing.site_tagline ?? null) : String(body.site_tagline),
    };
    if (["en", "bn", "ar"].includes(String(body.default_language))) {
      changes.default_language = String(body.default_language);
    }
    // Delivery rules belong to the same panel. They were missing from this
    // whitelist, so an admin could edit `delivery_fee` / `delivery_areas` in
    // Site Settings, get "✅ updated", and checkout would keep charging the
    // seeded ৳10 to Kalai only — the write was dropped without a word.
    // `settingsService.update` still validates each value (non-negative number).
    for (const key of ["delivery_fee", "delivery_areas", "free_shipping_threshold"] as const) {
      if (body[key] !== undefined) changes[key] = pick(key);
    }
    await settingsService.update(actor, changes);
    return { success: true, message: "✅ Site settings updated successfully!" };
  },

  // ------------------------------- branding -------------------------------

  /** GET /api/admin/branding */
  async brandingGet() {
    const settings = await loadSettings();
    return { success: true, settings: settingsForAdmin(settings) };
  },

  /**
   * POST /api/admin/branding — multipart: logo + favicon files plus
   * site_name / site_tagline / site_description / brand_* text fields.
   */
  async brandingPost(
    actor: SafeUser,
    body: Record<string, unknown>,
    files: { logo?: UploadedImage | null; favicon?: UploadedImage | null },
  ) {
    const s = await loadSettings();
    const hex = (v: unknown, fallback: string) =>
      /^#[0-9a-fA-F]{6}$/.test(String(v ?? "").trim()) ? String(v).trim() : fallback;
    const fontStyle = FONT_STYLES.includes(str(body.brand_font_style) || "") ? str(body.brand_font_style)! : "calligraphic";

    const changes: Record<string, string | null> = {
      site_name: str(body.site_name) || s.site_name,
      site_tagline: body.site_tagline === undefined ? s.site_tagline : String(body.site_tagline),
      site_description: body.site_description === undefined ? s.site_description : String(body.site_description),
      brand_primary: hex(body.brand_primary, s.brand_primary || "#e31b23"),
      brand_accent: hex(body.brand_accent, s.brand_accent || "#ff3340"),
      brand_font_style: fontStyle,
    };
    const bits: string[] = [];
    if (files.logo) {
      const file = await uploadService.store(files.logo);
      changes.logo_file = file;
      bits.push("logo");
    }
    if (files.favicon) {
      const file = await uploadService.store(files.favicon);
      changes.favicon_file = file;
      bits.push("favicon");
    }
    await settingsService.update(actor, changes);
    return {
      success: true,
      message: `✅ Branding saved${bits.length ? ` (uploaded: ${bits.join(", ")})` : ""}. Reload the site to see it everywhere.`,
    };
  },

  // --------------------------------- SMTP ---------------------------------

  /** GET /api/admin/smtp */
  async smtpGet() {
    const settings = await loadSettings();
    return { success: true, settings: settingsForAdmin(settings) };
  },

  /** POST /api/admin/smtp — bullets mean "keep the stored password". */
  async smtpPost(actor: SafeUser, body: Record<string, unknown>) {
    const s = await loadSettings();
    let pass: string | null = s.smtp_pass || "";
    if (body.smtp_pass !== undefined) {
      const incoming = String(body.smtp_pass);
      if (incoming === "") pass = "";
      else if (!incoming.includes("•")) pass = incoming;
    }
    const changes: Record<string, string | null> = {
      smtp_enabled: body.smtp_enabled ? "1" : "0",
      smtp_host: str(body.smtp_host) ?? "",
      smtp_port: String(parseInt(String(body.smtp_port || "587"), 10) || 587),
      smtp_secure: body.smtp_secure ? "1" : "0",
      smtp_user: str(body.smtp_user) ?? "",
      smtp_pass: pass,
      smtp_from_name: str(body.smtp_from_name) || s.site_name || "BloodOra",
      smtp_from_email: str(body.smtp_from_email) ?? "",
    };
    await settingsService.update(actor, changes);
    return { success: true, message: "✅ SMTP settings saved." };
  },

  /** POST /api/admin/smtp/test */
  async smtpTest(_actor: SafeUser, to?: string) {
    return smtpService.test(to);
  },

  /** GET /api/admin/smtp/log */
  async smtpLog() {
    const logs = await contentRepo.recentEmailLogs(100);
    return { success: true, logs };
  },

  // --------------------------- content: Anti-D ---------------------------

  async antidList() {
    const entries = await contentRepo.listAntiD();
    return { success: true, entries, reference: antidReference };
  },

  async antidCreate(actor: SafeUser, body: Record<string, unknown>) {
    const title = str(body.title)?.trim();
    const description = str(body.description)?.trim();
    if (!title || !description) throw ApiError.badRequest("❌ Title and description are required.", "REQUIRED_FIELDS");
    await contentRepo.insertAntiD({
      id: randomId(),
      title,
      description,
      timing: str(body.timing)?.trim() ?? "",
      dosage: str(body.dosage)?.trim() ?? "",
      image_file: null,
    });
    await activityRepo.create("content", actor.id, `Anti-D entry "${title}" added`);
    return { success: true, message: "✅ Anti-D entry added." };
  },

  async antidUpdate(actor: SafeUser, id: string, body: Record<string, unknown>) {
    const row = await contentRepo.getAntiD(id);
    if (!row) throw ApiError.notFound("Entry not found.", "NOT_FOUND");
    await contentRepo.updateAntiD(id, {
      title: str(body.title) ?? row.title,
      description: str(body.description) ?? row.description,
      timing: str(body.timing) ?? row.timing,
      dosage: str(body.dosage) ?? row.dosage,
    });
    await activityRepo.create("content", actor.id, `Anti-D entry "${row.title}" updated`);
    return { success: true, message: "✅ Anti-D entry updated." };
  },

  async antidDelete(actor: SafeUser, id: string) {
    const row = await contentRepo.getAntiD(id);
    if (!row) throw ApiError.notFound("Entry not found.", "NOT_FOUND");
    await contentRepo.deleteAntiD(id);
    await activityRepo.create("content", actor.id, `Anti-D entry "${row.title}" deleted`);
    return { success: true, message: `🗑️ “${row.title}” deleted. The built-in clinical reference still shows on the page.` };
  },

  // ------------------------ content: resources ------------------------

  async resourcesList() {
    const rows = await contentRepo.listResourcesAll();
    return { success: true, resources: rows, core: resourcesReference };
  },

  async resourceCreate(actor: SafeUser, body: Record<string, unknown>) {
    const title = str(body.title)?.trim();
    const content = str(body.content)?.trim();
    if (!title || !content) throw ApiError.badRequest("❌ Title and content are required.", "REQUIRED_FIELDS");
    await contentRepo.insertResource({
      id: randomId(),
      title,
      category: str(body.category)?.trim() || "Education",
      content,
      summary: str(body.summary)?.trim() ?? "",
      read_time: str(body.read_time)?.trim() ?? "",
      image_file: null,
      is_featured: body.is_featured ? 1 : 0,
      source: "admin",
    });
    await activityRepo.create("content", actor.id, `Resource "${title}" published`);
    return { success: true, message: "✅ Resource published." };
  },

  async resourceUpdate(actor: SafeUser, id: string, body: Record<string, unknown>) {
    const row = await contentRepo.getResource(id);
    if (!row) throw ApiError.notFound("Resource not found.", "NOT_FOUND");
    await contentRepo.updateResource(id, {
      title: str(body.title) ?? row.title,
      category: str(body.category) ?? row.category ?? null,
      content: str(body.content) ?? row.content,
      summary: str(body.summary) ?? row.summary ?? "",
      read_time: str(body.read_time) ?? row.read_time ?? "",
      is_featured: body.is_featured === undefined ? row.is_featured : body.is_featured ? 1 : 0,
    });
    await activityRepo.create("content", actor.id, `Resource "${row.title}" updated`);
    return { success: true, message: "✅ Resource updated." };
  },

  async resourceDelete(actor: SafeUser, id: string) {
    const row = await contentRepo.getResource(id);
    if (!row) throw ApiError.notFound("Resource not found.", "NOT_FOUND");
    await contentRepo.deleteResource(id);
    await activityRepo.create("content", actor.id, `Resource "${row.title}" deleted`);
    return { success: true, message: `🗑️ “${row.title}” deleted.` };
  },

  // ---------------------------- activity feed ----------------------------

  /** GET /api/admin/activity — recent feed events (original shape). */
  async activityEvents() {
    const rows = await activityRepo.list(100, 0);
    return { success: true, events: rows.map(presentEvent) };
  },

  /** POST /api/admin/activity/announce — {title, detail?, link?}. */
  async announce(actor: SafeUser, body: Record<string, unknown>) {
    const title = str(body.title)?.trim();
    if (!title) throw ApiError.badRequest("❌ A headline is required.", "TITLE_REQUIRED");
    const detail = str(body.detail)?.trim() ?? "";
    const link = str(body.link)?.trim() || "/";
    await activityRepo.create("notice", actor.id, title, { detail, link });
    return { success: true, message: "📣 Announced to the Live Activity feed." };
  },

  // ------------------------------- site notice -------------------------------

  async setNotice(actor: SafeUser, body: Record<string, unknown>) {
    const content = str(body.notice_content)?.trim();
    if (!content) throw ApiError.badRequest("⚠️ Notice cannot be empty.", "NOTICE_EMPTY");
    await contentRepo.setNotice(content);
    await activityRepo.create("notice", actor.id, "Site notice updated", { detail: content });
    return { success: true, message: "✅ Site notice updated." };
  },

  async clearNotice(actor: SafeUser) {
    await contentRepo.clearNotice();
    await activityRepo.create("notice", actor.id, "Site notice cleared");
    return { success: true, type: "info", message: "ℹ️ Notice cleared." };
  },

  // ------------------------ donor verification / roles ------------------------

  /** POST /api/admin/verify-donor/:id — 18+ gate, activity row with link. */
  async verifyDonor(actor: SafeUser, id: string) {
    const user = await userRepo.findById(id);
    if (!user) throw ApiError.notFound("User not found.", "USER_NOT_FOUND");
    if (!(user.age && user.age >= 18)) {
      throw ApiError.badRequest("⚠️ User must be 18+ to be verified.", "UNDER_18");
    }
    await userRepo.setVerified(id, true);
    await activityRepo.create(
      "donor_verified",
      actor.id,
      `${user.blood_group || "Donor"} donor verified`,
      { detail: `${initials(user.name)} • ${user.upazila || user.district || "Bangladesh"}`, link: `/donors/profile/view/${user.id}` },
    );
    return { success: true, message: `✅ ${user.name} is now a verified donor!` };
  },

  /** POST /api/admin/promote/:id (super admin). */
  async promote(actor: SafeUser, id: string) {
    const target = await userRepo.findById(id);
    if (!target) throw ApiError.notFound("User not found.", "USER_NOT_FOUND");
    await userRepo.setSuperAdmin(id, target.is_super_admin === 1, true);
    await activityRepo.create("role_change", actor.id, `${actor.name} promoted ${target.name} to Admin`, { user: id });
    return { success: true, message: `✅ ${target.name} is now an Admin.` };
  },

  /** POST /api/admin/demote/:id (super admin). */
  async demote(actor: SafeUser, id: string) {
    const target = await userRepo.findById(id);
    if (!target) throw ApiError.notFound("User not found.", "USER_NOT_FOUND");
    if (target.is_super_admin === 1) {
      throw ApiError.badRequest("⚠️ Cannot demote Super Admin.", "SUPER_ADMIN_PROTECTED");
    }
    await userRepo.setSuperAdmin(id, false, false);
    await activityRepo.create("role_change", actor.id, `${actor.name} demoted ${target.name} from Admin`, { user: id });
    return { success: true, type: "info", message: `ℹ️ Admin rights removed from ${target.name}.` };
  },

  /** DELETE /api/admin/user/:id (super admin). */
  async deleteUser(actor: SafeUser, id: string) {
    const target = await userRepo.findById(id);
    if (!target) throw ApiError.notFound("User not found.", "USER_NOT_FOUND");
    if (target.is_super_admin === 1) {
      throw ApiError.badRequest("⚠️ Cannot delete Super Admin.", "SUPER_ADMIN_PROTECTED");
    }
    if (target.id === actor.id) {
      throw ApiError.badRequest("⚠️ Cannot delete your own account.", "SELF_DELETE");
    }
    await userRepo.delete(id);
    await activityRepo.create("user_delete", actor.id, `${actor.name} deleted the account of ${target.name}`, { user: id });
    return { success: true, message: `✅ User '${target.name}' deleted.` };
  },

  /** POST /api/admin/user/update/:id (super admin). */
  async updateUser(actor: SafeUser, id: string, body: Record<string, unknown>) {
    const user = await userRepo.findById(id);
    if (!user) throw ApiError.notFound("User not found.", "USER_NOT_FOUND");
    if (user.is_super_admin === 1 || user.id === actor.id) {
      throw ApiError.badRequest("⚠️ Cannot edit this user.", "PROTECTED_USER");
    }
    await userRepo.updateProfile(id, {
      name: str(body.name) ?? user.name,
      email: str(body.email) ?? user.email,
      phone: str(body.phone) ?? user.phone,
      blood_group: str(body.blood_group) ?? user.blood_group ?? null,
      district: str(body.district) ?? user.district ?? null,
      upazila: str(body.upazila) ?? user.upazila ?? null,
      address_holding: str(body.address_holding) ?? user.address_holding ?? null,
    });
    await userRepo.setVerified(id, Boolean(body.is_verified));
    await userRepo.setRole(id, body.is_admin ? "admin" : "user", Boolean(body.is_admin));
    await userRepo.setCanDonate(id, Boolean(body.can_donate));
    await activityRepo.create("user_update", actor.id, `${actor.name} updated ${user.name}`, { user: id });

    const newPassword = str(body.new_password);
    if (newPassword && newPassword.length >= 6) {
      await userRepo.setPassword(id, await bcrypt.hash(newPassword, 10));
      await userRepo.setSessionToken(id, randomId());
      return { success: true, type: "info", message: "🔑 Password changed. User will need to login again." };
    }
    return { success: true, message: `✅ User '${str(body.name) || user.name}' updated!` };
  },

  /** GET /api/admin/user/details/:id (super admin). */
  async userDetails(_actor: SafeUser, id: string) {
    const u = await userRepo.findById(id);
    if (!u) throw ApiError.notFound("Not found.", "USER_NOT_FOUND");
    return {
      success: true,
      user: {
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        blood_group: u.blood_group,
        district: u.district,
        upazila: u.upazila,
        address_holding: u.address_holding,
        is_verified: Boolean(u.is_verified),
        is_admin: Boolean(u.is_admin),
        can_donate: Boolean(u.can_donate),
        created_at: u.created_at ? u.created_at.slice(0, 10) : null,
      },
    };
  },

  /** POST /api/admin/create-admin (super admin). */
  async createAdmin(_actor: SafeUser, body: Record<string, unknown>) {
    const name = str(body.name)?.trim();
    const email = str(body.email)?.trim();
    const password = str(body.password);
    if (!name || !email || !password) {
      throw ApiError.badRequest("❌ Name, email and password are required.", "REQUIRED_FIELDS");
    }
    if (await userRepo.findByEmail(email)) {
      throw ApiError.conflict("⚠️ Email already registered.", "EMAIL_TAKEN");
    }
    await userRepo.create({
      id: randomId(),
      name,
      email,
      phone: str(body.phone) ?? "",
      password_hash: await bcrypt.hash(password, 10),
      is_admin: 1,
      is_super_admin: 0,
      role: "admin",
      donation_role: "Both",
      blood_group: "O+",
      city: "Joypurhat",
      address_holding: null,
      division: "Rajshahi",
      district: "Joypurhat",
      upazila: "Kalai",
      union_area: null,
      can_donate: 1,
      age: 25,
      date_of_birth: null,
      birth_certificate_number: null,
      bkash_number: null,
      nagad_number: null,
      upay_number: null,
      rocket_number: null,
      pathao_number: null,
      card_last_four: null,
      card_type: null,
      is_verified: 1,
      last_donation: null,
      image_file: null,
      session_token: randomId(),
    });
    return { success: true, message: `✅ New admin '${name}' created!` };
  },

  // ----------------------------- impersonation -----------------------------

  /** POST /api/admin/impersonate/:id (super admin) — returns the target's token. */
  async impersonate(actor: SafeUser, id: string) {
    const target = await userRepo.findById(id);
    if (!target) throw ApiError.notFound("User not found.", "USER_NOT_FOUND");
    if (target.is_super_admin === 1 || target.id === actor.id) {
      throw ApiError.badRequest("⚠️ Cannot impersonate.", "IMPERSONATE_BLOCKED");
    }
    const { token, user } = await authService.impersonate(actor.id, id);
    return {
      success: true,
      token,
      user,
      message: `🎭 Now logged in as ${target.name}. Go to profile to switch back.`,
    };
  },

  /** POST /api/admin/switch-back — revoke the impersonated user's session. */
  async switchBack(actor: SafeUser, impersonatedUserId?: string) {
    if (impersonatedUserId) {
      await userRepo.setSessionToken(impersonatedUserId, randomId());
    }
    await activityRepo.create("impersonate", actor.id, `${actor.name} switched back from an impersonated session`, {
      target: impersonatedUserId ?? null,
    });
    return { success: true, message: "🔙 Switched back to admin account." };
  },

  // --------------------------------- backup ---------------------------------

  /** GET /api/admin/backup (super admin) — static Turso notice. */
  async backup() {
    return {
      success: true,
      type: "info",
      message: "📥 This deployment uses the Turso serverless database — create backups from the Turso dashboard (turso.tech).",
    };
  },
};

