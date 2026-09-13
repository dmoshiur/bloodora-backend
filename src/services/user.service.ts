import bcrypt from "bcryptjs";
import { userRepo } from "../repos/user.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { settingsRepo } from "../repos/settings.repo.js";
import { orderRepo } from "../repos/order.repo.js";
import { bloodRequestRepo } from "../repos/bloodRequest.repo.js";
import { reviewRepo } from "../repos/review.repo.js";
import { messageRepo } from "../repos/message.repo.js";
import { notificationService } from "./notification.service.js";
import { paymentService } from "./payment.service.js";
import { ApiError, maskPhone } from "../utils/errors.js";
import { str, toBool } from "../utils/validate.js";
import { normalizeLang } from "../i18n/index.js";
import { LANGUAGES } from "../data/constants.js";
import { toSafeUser } from "../utils/userShape.js";
import { nowIso } from "../utils/time.js";
import type { SafeUser, UserRow } from "../types.js";

export const userService = {
  /**
   * GET /api/user/dashboard — one call with everything the signed-in user's
   * home screen needs: identity, donation status, order/request/message counts,
   * unread badges, spending and the most recent items of each kind.
   *
   * Previously a client had to fan out to six endpoints (and the admin
   * dashboard was the only aggregate view that existed). Every read is scoped to
   * `user.id` from the session — no id is taken from the request.
   */
  async dashboard(user: SafeUser) {
    const [orders, requestCounts, requests, reviews, unreadMessages, notifications, transactions] = await Promise.all([
      orderRepo.byUser(user.id, 5),
      bloodRequestRepo.countByUser(user.id),
      bloodRequestRepo.listByUser(user.id, 5),
      reviewRepo.byUser(user.id),
      messageRepo.unreadCount(user.id),
      notificationService.summaryFor(user),
      paymentService.myTransactions(user.id, { limit: 5 }),
    ]);

    const orderCounts = orders.reduce(
      (acc, o) => {
        acc.total += 1;
        if (o.status === "pending") acc.pending += 1;
        else if (o.status === "delivered") acc.delivered += 1;
        else if (o.status === "cancelled") acc.cancelled += 1;
        else acc.processing += 1;
        if (o.payment_status === "confirmed") acc.paid += 1;
        return acc;
      },
      { total: 0, pending: 0, processing: 0, delivered: 0, cancelled: 0, paid: 0 },
    );

    const spent = transactions
      .filter((t) => t.kind === "charge" && t.status === "successful")
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);

    return {
      success: true,
      user: toSafeUser((await userRepo.findById(user.id)) ?? (user as unknown as UserRow)),
      donation: {
        blood_group: user.blood_group ?? null,
        can_donate: Boolean(user.can_donate),
        is_verified: Boolean(user.is_verified),
        last_donation: user.last_donation ?? null,
        eligible: Boolean(user.can_donate) && Boolean(user.is_verified),
      },
      counts: {
        orders: orderCounts,
        requests: requestCounts,
        reviews: reviews.length,
        unread_messages: unreadMessages,
        unread_notifications: notifications.unread,
        notifications_by_type: notifications.byType,
      },
      spending: {
        total: Math.round(spent * 100) / 100,
        currency: "BDT",
      },
      recent: {
        orders: orders.map((o) => ({
          id: o.id,
          status: o.status,
          payment_status: o.payment_status,
          total: Number(o.total),
          items: null,
          created_at: o.created_at,
        })),
        requests: requests.map((r) => ({
          id: r.id,
          blood_group: r.blood_group,
          units: r.units,
          district: r.district,
          upazila: r.upazila,
          urgent: Boolean(r.urgent),
          status: r.status,
          needed_by: r.needed_by,
          created_at: r.created_at,
        })),
        reviews: reviews.slice(0, 5).map((r) => ({
          id: r.id,
          rating: r.rating,
          status: r.status,
          product_name: r.product_name,
          created_at: r.created_at,
        })),
        transactions,
      },
      server_time: nowIso(),
    };
  },

  async updateProfile(userId: string, body: Record<string, unknown>): Promise<SafeUser> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");

    const name = str(body.name);
    const email = str(body.email);
    const phone = str(body.phone);
    const bloodGroup = str(body.blood_group);
    const city = str(body.city);

    if (email && email.toLowerCase() !== row.email.toLowerCase()) {
      const taken = await userRepo.findByEmail(email);
      if (taken) throw ApiError.conflict("Email already in use", "EMAIL_TAKEN");
    }

    await userRepo.updateProfile(userId, {
      ...(name ? { name } : {}),
      ...(email ? { email: email.toLowerCase() } : {}),
      ...(phone ? { phone } : {}),
      ...(bloodGroup ? { blood_group: bloodGroup } : {}),
      ...(city ? { city } : {}),
    });

    await activityRepo.create("profile", userId, `${name || row.name} updated their profile`);
    const fresh = (await userRepo.findById(userId))!;
    return toSafeUser(fresh);
  },

  /**
   * PATCH /api/users/me/preferences — language + notification channels.
   *
   * These three columns drive real behaviour, so they have to be writable:
   *   - `language` picks the catalogue every notification and email to this
   *     account is rendered in (and the request language once signed in);
   *   - `notify_inapp` / `notify_email` let somebody turn a channel off.
   * Without an endpoint they were defaults nobody could change.
   *
   * Absent fields are left untouched (SQL `COALESCE`), so a client may send one
   * key at a time. Booleans follow the panel's checkbox convention: the value
   * "on" means true, and an explicitly sent false/0 means false.
   */
  async setPreferences(userId: string, body: Record<string, unknown>): Promise<SafeUser> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");

    const fields: { language?: string; notify_email?: boolean; notify_inapp?: boolean } = {};

    if (body.language !== undefined) {
      const lang = normalizeLang(str(body.language));
      if (!lang || !LANGUAGES.includes(lang)) {
        throw ApiError.badRequest(`language must be one of: ${LANGUAGES.join(", ")}`, "BAD_LANGUAGE");
      }
      fields.language = lang;
    }
    for (const key of ["notify_email", "notify_inapp"] as const) {
      if (body[key] !== undefined) fields[key] = toBool(body[key]);
    }
    if (Object.keys(fields).length === 0) {
      throw ApiError.badRequest("Nothing to update (send language, notify_email or notify_inapp).", "NO_CHANGES");
    }

    await userRepo.setPreferences(userId, fields);
    const fresh = (await userRepo.findById(userId))!;
    return toSafeUser(fresh);
  },

  async setProfileImage(userId: string, imageFile: string): Promise<SafeUser> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");
    await userRepo.updateProfile(userId, { image_file: imageFile });
    const fresh = (await userRepo.findById(userId))!;
    return toSafeUser(fresh);
  },

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");
    const ok = await bcrypt.compare(current, row.password_hash);
    if (!ok) throw ApiError.unauthorized("Current password is incorrect", "BAD_CREDENTIALS");
    if (next.length < 8) throw ApiError.badRequest("New password must be at least 8 characters", "PASSWORD_SHORT");
    await userRepo.setPassword(userId, await bcrypt.hash(next, 10));
    await activityRepo.create("password", userId, "A password was changed");
  },

  async setVerification(userId: string, verified: boolean): Promise<SafeUser> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");
    await userRepo.setVerified(userId, verified);
    await activityRepo.create(verified ? "verify" : "unverify", userId, verified ? `${row.name} was verified as a donor` : `${row.name} was unverified`);
    const fresh = (await userRepo.findById(userId))!;
    return toSafeUser(fresh);
  },

  async listDonors(opts: { bg?: string; dist?: string; upa?: string; ageMin?: number } = {}): Promise<SafeUser[]> {
    const rows = await userRepo.listDonors({
      bg: opts.bg,
      dist: opts.dist,
      upa: opts.upa,
      ageMin: opts.ageMin,
      limit: 200,
    });
    return rows.map(normalizeFlags);
  },

  /** GET /api/users/:id — full profile (flags normalized to booleans). */
  async publicProfile(id: string): Promise<SafeUser> {
    const row = await userRepo.findById(id);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");
    return normalizeFlags(row);
  },

  /** PUT /api/users/me — self-service edit (multipart fields + optional image). */
  async selfUpdate(
    userId: string,
    fields: { name?: string; phone?: string; holding?: string; birth_certificate?: string; date_of_birth?: string },
    imageFile?: string | null,
  ): Promise<{ user: SafeUser; message: string }> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");

    let dob = row.date_of_birth;
    let age = row.age;
    if (fields.date_of_birth) {
      dob = fields.date_of_birth;
      const computed = calculateAge(fields.date_of_birth);
      if (computed != null) age = computed;
    }

    await userRepo.updateProfile(userId, {
      ...(fields.name ? { name: fields.name } : {}),
      ...(fields.phone ? { phone: fields.phone } : {}),
      ...(fields.holding !== undefined ? { address_holding: fields.holding || null } : {}),
      ...(fields.birth_certificate !== undefined ? { birth_certificate_number: fields.birth_certificate || null } : {}),
      ...(fields.date_of_birth ? { date_of_birth: dob, age } : {}),
      ...(imageFile ? { image_file: imageFile } : {}),
    });
    const fresh = (await userRepo.findById(userId))!;
    return { user: normalizeFlags(fresh), message: "✅ Profile updated successfully!" };
  },

  /** POST /api/users/me/toggle-status — donation availability. */
  async toggleStatus(userId: string): Promise<{ can_donate: boolean; message: string }> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");
    const next = await userRepo.toggleCanDonate(userId, row.can_donate);
    await activityRepo.create("donation", userId, `${row.name} marked themselves ${next ? "available" : "unavailable"} for donation`);
    return {
      can_donate: next === 1,
      message: `✅ Donation status updated: ${next ? "Available" : "Unavailable"}`,
    };
  },

  /** POST /api/users/me/apply-verification — 18+ gate, admin reviews after. */
  async applyVerification(userId: string): Promise<{ type: string; message: string }> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");
    if (row.age && row.age >= 18) {
      await activityRepo.create("verify", userId, `${row.name} applied for donor verification`, { stage: "applied" });
      return { type: "info", message: "ℹ️ Verification request submitted. Admin will review within 24 hours." };
    }
    throw ApiError.badRequest("⚠️ You must be 18+ to apply.", "UNDER_18");
  },

  async donateCount(): Promise<number> {
    const raw = await settingsRepo.get("total_donations");
    return raw ? Number(raw) : 0;
  },
};

/** 0/1 flag columns → booleans (shared shaper; see utils/userShape.ts). */
const normalizeFlags = toSafeUser;

function calculateAge(dob: string): number | null {
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}
