import { notificationRepo, ADMIN_DESK, type NotificationRow, type NewNotification } from "../repos/notification.repo.js";
import { userRepo } from "../repos/user.repo.js";
import { translate, type Lang } from "../i18n/index.js";
import { logger } from "../utils/logger.js";
import { nowIso } from "../utils/time.js";
import type { SafeUser } from "../types.js";

/**
 * Notification system.
 *
 * Every notification is a real database row addressed to one recipient (a user
 * id, or the `admins` desk sentinel) and created through a UNIQUE dedupe key, so
 * a retried request or a re-delivered event never produces a duplicate bell
 * entry. Text is rendered in the recipient's own language at creation time —
 * a notification is a message, not a template reference, so it must stay
 * readable even if the user later switches language.
 *
 * Delivery is best-effort by design: a notification failure must never fail the
 * business operation that triggered it. Callers use `emit()` which swallows and
 * logs its own errors.
 */

export type NotificationEvent =
  | "order_placed"
  | "order_status"
  | "order_cancelled"
  | "payment_confirmed"
  | "payment_refunded"
  | "blood_created"
  | "blood_fulfilled"
  | "blood_cancelled"
  | "message_reply"
  | "review_approved"
  | "review_rejected"
  | "donor_verified"
  | "password_changed"
  | "password_reset"
  | "new_login"
  | "email_verified"
  | "admin_new_order"
  | "admin_new_request"
  | "admin_chat"
  | "admin_message"
  | "admin_review"
  | "admin_announcement"
  | "admin_user_role"
  | "system";

interface Template {
  type: string;
  level: "info" | "success" | "warning" | "danger";
  title: string;
  body: string | null;
  link: string | null;
}

const TEMPLATES: Record<NotificationEvent, Template> = {
  order_placed: { type: "order", level: "success", title: "notify.order.placed.title", body: "notify.order.placed.body", link: "/shop/my-orders" },
  order_status: { type: "order", level: "info", title: "notify.order.status.title", body: "notify.order.status.body", link: "/shop/my-orders" },
  order_cancelled: { type: "order", level: "warning", title: "notify.order.status.title", body: "notify.order.status.body", link: "/shop/my-orders" },
  payment_confirmed: { type: "payment", level: "success", title: "notify.payment.success.title", body: "notify.payment.success.body", link: "/shop/my-orders" },
  payment_refunded: { type: "payment", level: "warning", title: "notify.payment.success.title", body: null, link: "/shop/my-orders" },
  blood_created: { type: "blood_request", level: "success", title: "notify.blood.created.title", body: "notify.blood.created.body", link: "/blood-requests" },
  blood_fulfilled: { type: "blood_request", level: "success", title: "notify.blood.fulfilled.title", body: "notify.blood.fulfilled.body", link: "/blood-requests" },
  blood_cancelled: { type: "blood_request", level: "info", title: "notify.blood.fulfilled.title", body: null, link: "/blood-requests" },
  message_reply: { type: "message", level: "info", title: "notify.message.reply.title", body: "notify.message.reply.body", link: "/messages" },
  review_approved: { type: "review", level: "success", title: "notify.review.approved.title", body: "notify.review.approved.body", link: "/reviews" },
  review_rejected: { type: "review", level: "warning", title: "notify.review.approved.title", body: null, link: "/reviews" },
  donor_verified: { type: "account", level: "success", title: "notify.donor.verified.title", body: "notify.donor.verified.body", link: "/donors/profile/my" },
  password_changed: { type: "security", level: "warning", title: "auth.security_password_changed", body: null, link: "/donors/profile/my" },
  password_reset: { type: "security", level: "warning", title: "auth.security_password_reset", body: null, link: "/donors/profile/my" },
  new_login: { type: "security", level: "info", title: "auth.security_new_login", body: null, link: "/donors/profile/my" },
  email_verified: { type: "account", level: "success", title: "auth.verify_done", body: null, link: "/donors/profile/my" },
  admin_new_order: { type: "order", level: "info", title: "notify.admin.new_order.title", body: "notify.admin.new_order.body", link: "/shop/admin/orders" },
  admin_new_request: { type: "blood_request", level: "danger", title: "notify.admin.new_request.title", body: "notify.admin.new_request.body", link: "/admin" },
  admin_chat: { type: "chat", level: "info", title: "notify.admin.chat.title", body: "notify.admin.chat.body", link: "/admin/live-chat" },
  admin_message: { type: "message", level: "info", title: "notify.admin.chat.title", body: "notify.message.reply.body", link: "/messages/admin/messages" },
  admin_review: { type: "review", level: "info", title: "notify.review.approved.title", body: null, link: "/admin/reviews" },
  admin_announcement: { type: "system", level: "info", title: "notify.admin.announcement.title", body: null, link: "/" },
  admin_user_role: { type: "account", level: "warning", title: "notify.admin.announcement.title", body: null, link: "/admin" },
  system: { type: "system", level: "info", title: "notify.admin.announcement.title", body: null, link: null },
};

export interface EmitInput {
  event: NotificationEvent;
  /** Deliver to these users. Omit for an admin-desk notification. */
  userIds?: string[] | null;
  /** Also deliver to the admin desk. */
  toAdmins?: boolean;
  params?: Record<string, string | number | null | undefined>;
  entityType?: string | null;
  entityId?: string | null;
  link?: string | null;
  /** Deterministic key → at most one notification per (recipient, key). */
  dedupeKey?: string | null;
  /** Override the recipient's stored language. */
  lang?: Lang | string | null;
  title?: string | null;
  body?: string | null;
}

/**
 * Recipient preferences, read once per emit.
 *
 * Enforcing `notify_inapp` HERE (rather than at each call site) is what makes the
 * preference real: every feature that emits — orders, payments, chat, reviews,
 * role changes — honours it without having to remember to. A missing/unreadable
 * row defaults to "deliver in English", because a preferences lookup failing must
 * not silently switch somebody's notifications off.
 */
async function prefsFor(userId: string): Promise<{ lang: string; inApp: boolean }> {
  try {
    const row = await userRepo.findById(userId);
    const lang = row?.language;
    // The column defaults to 1; only an explicit opt-out disables the channel.
    const inApp = row?.notify_inapp === undefined || row?.notify_inapp === null ? true : Boolean(row.notify_inapp);
    return { lang: typeof lang === "string" && lang ? lang : "en", inApp };
  } catch {
    return { lang: "en", inApp: true };
  }
}

async function languageFor(userId: string): Promise<string> {
  return (await prefsFor(userId)).lang;
}

function render(tpl: Template, lang: string, params: Record<string, string | number | null | undefined>, input: EmitInput) {
  return {
    title: (input.title ?? translate(lang, tpl.title, params)).slice(0, 200),
    body: input.body !== undefined && input.body !== null ? String(input.body).slice(0, 1000) : tpl.body ? translate(lang, tpl.body, params).slice(0, 1000) : null,
  };
}

export const notificationService = {
  ADMIN_DESK,

  /**
   * Create notifications for one event. Returns how many rows were actually
   * inserted (0 when every recipient had already received it).
   */
  async emit(input: EmitInput): Promise<number> {
    const tpl = TEMPLATES[input.event] ?? TEMPLATES.system;
    const params = input.params ?? {};
    let created = 0;

    const recipients: { id: string; audience: NewNotification["audience"] }[] = [];
    for (const id of input.userIds ?? []) {
      if (id) recipients.push({ id, audience: "user" });
    }
    if (input.toAdmins) recipients.push({ id: ADMIN_DESK, audience: "admin" });
    if (recipients.length === 0) return 0;

    for (const r of recipients) {
      try {
        // The shared admin desk is a queue, not a person: it has no preferences
        // to honour and must always receive.
        const prefs = r.audience === "admin" ? { lang: "en", inApp: true } : await prefsFor(r.id);
        if (!prefs.inApp) continue;
        const lang = input.lang ?? prefs.lang;
        const text = render(tpl, lang, params, input);
        const row = await notificationRepo.create({
          userId: r.id,
          audience: r.audience,
          type: tpl.type,
          level: tpl.level,
          title: text.title,
          body: text.body,
          lang,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          link: input.link !== undefined ? input.link : tpl.link,
          // One key per recipient: the same event for two users must not
          // collide, so the recipient is always part of the key.
          dedupeKey: input.dedupeKey ? `${r.id}:${input.dedupeKey}` : null,
        });
        if (row) created += 1;
      } catch (err) {
        // Never let a notification break the operation that caused it.
        logger.warn("notification: emit failed", { event: input.event, err: String((err as Error)?.message ?? err) });
      }
    }
    return created;
  },

  /** Fire-and-forget wrapper for hot paths (chat, activity writes). */
  emitAsync(input: EmitInput): void {
    void this.emit(input).catch((err) => {
      logger.warn("notification: async emit failed", { err: String((err as Error)?.message ?? err) });
    });
  },

  async list(userId: string, opts: { unreadOnly?: boolean; limit?: number; offset?: number } = {}): Promise<NotificationRow[]> {
    return notificationRepo.listFor(userId, opts);
  },

  async unreadCount(userId: string): Promise<number> {
    return notificationRepo.unreadCount(userId);
  },

  async summary(userId: string): Promise<{ unread: number; byType: Record<string, number> }> {
    const [unread, byType] = await Promise.all([notificationRepo.unreadCount(userId), notificationRepo.countByType(userId)]);
    return { unread, byType: Object.fromEntries(byType.map((r) => [r.type, r.n])) };
  },

  /**
   * Recipient set for a caller: their own id, plus the shared admin desk when
   * their account role is admin/super_admin. `SafeUser.role` is the ACCOUNT role
   * (`adminService.userView` maps the donation role separately), so this check is
   * authorization-relevant and not a display detail.
   */
  recipientsFor(user: SafeUser): string[] {
    const ids = [user.id];
    if (user.role && user.role !== "user") ids.push(ADMIN_DESK);
    else if (user.is_admin || user.is_super_admin) ids.push(ADMIN_DESK);
    return ids;
  },

  /** GET /api/notifications — the caller's feed (own + admin desk). */
  async feed(user: SafeUser, opts: { unreadOnly?: boolean; limit?: number; offset?: number } = {}) {
    const ids = this.recipientsFor(user);
    const [rows, summary] = await Promise.all([
      notificationRepo.listForMany(ids, opts),
      this.summaryFor(user),
    ]);
    return {
      success: true,
      notifications: rows.map(shapeNotification),
      unread: summary.unread,
      by_type: summary.byType,
      server_time: nowIso(),
    };
  },

  async summaryFor(user: SafeUser): Promise<{ unread: number; byType: Record<string, number> }> {
    const ids = this.recipientsFor(user);
    const [unread, byType] = await Promise.all([
      notificationRepo.unreadCountForMany(ids),
      notificationRepo.countByTypeForMany(ids),
    ]);
    return { unread, byType: Object.fromEntries(byType.map((r) => [r.type, r.n])) };
  },

  async readOne(user: SafeUser, id: string): Promise<boolean> {
    return notificationRepo.markReadForMany(this.recipientsFor(user), id);
  },

  async readAll(user: SafeUser): Promise<number> {
    return notificationRepo.markAllReadForMany(this.recipientsFor(user));
  },

  async removeOne(user: SafeUser, id: string): Promise<boolean> {
    return notificationRepo.removeForMany(this.recipientsFor(user), id);
  },

  async markRead(userId: string, id: string): Promise<boolean> {
    return notificationRepo.markRead(userId, id);
  },

  async markAllRead(userId: string): Promise<number> {
    return notificationRepo.markAllRead(userId);
  },

  async remove(userId: string, id: string): Promise<boolean> {
    return notificationRepo.remove(userId, id);
  },
};

/** JSON shape sent to clients (stable API contract). */
export function shapeNotification(row: NotificationRow) {
  return {
    id: row.id,
    type: row.type,
    level: row.level,
    title: row.title,
    body: row.body,
    lang: row.lang,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    link: row.link,
    is_read: Boolean(row.is_read),
    read_at: row.read_at,
    created_at: row.created_at,
  };
}
