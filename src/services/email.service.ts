import { smtpService, resolveSmtpSettings } from "./smtp.service.js";
import { outboxRepo } from "../repos/outbox.repo.js";
import { contentRepo } from "../repos/content.repo.js";
import { orderRepo } from "../repos/order.repo.js";
import { userRepo } from "../repos/user.repo.js";
import { translate, LANGUAGE_META, normalizeLang, type Lang } from "../i18n/index.js";
import { logger } from "../utils/logger.js";
import { maskEmail } from "../utils/errors.js";
import { config } from "../config/env.js";
import { budgetExhausted } from "../utils/deadline.js";

/**
 * Transactional email: localized templates + a durable outbox.
 *
 * Why the outbox: a serverless instance can be frozen immediately after the
 * response is sent, so a fire-and-forget `sendMail()` may never execute. Every
 * message is persisted first and then attempted inline; anything that did not go
 * out is retried by `flush()` (called by the maintenance cron and by
 * `POST /api/admin/smtp/flush`).
 *
 * Templates are rendered in the recipient's language and Arabic renders
 * right-to-left, matching the frontend.
 */

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

interface LayoutInput {
  lang: Lang;
  title: string;
  paragraphs: string[];
  cta?: { href: string; label: string } | null;
  table?: { label: string; value: string }[] | null;
  footerNote?: string | null;
}

/** Shared HTML shell (RTL-aware, no external assets). */
export function layout({ lang, title, paragraphs, cta, table, footerNote }: LayoutInput): string {
  const dir = LANGUAGE_META[lang].dir;
  const align = dir === "rtl" ? "right" : "left";
  const rows = (table ?? [])
    .map(
      (r) =>
        `<tr><td style="padding:6px 0;color:#64748b;">${escapeHtml(r.label)}</td>` +
        `<td style="padding:6px 0;text-align:${dir === "rtl" ? "left" : "right"};font-weight:600;">${escapeHtml(r.value)}</td></tr>`,
    )
    .join("");
  return `<div dir="${dir}" style="font-family:Georgia,'Noto Serif Bengali',serif;max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;background:#fff;">
    <div style="background:linear-gradient(135deg,#e31b23,#ff3340);color:#fff;padding:22px 26px;">
      <div style="font-size:22px;font-weight:700;">BloodOra</div>
      <div style="opacity:.9;">${escapeHtml(title)}</div>
    </div>
    <div style="padding:26px;color:#0f172a;text-align:${align};">
      ${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.6;margin:0 0 14px;">${p}</p>`).join("")}
      ${cta ? `<p style="margin:22px 0;"><a href="${escapeHtml(cta.href)}" style="display:inline-block;background:#e31b23;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:700;">${escapeHtml(cta.label)}</a></p>` : ""}
      ${table?.length ? `<table style="width:100%;font-size:13px;border-collapse:collapse;margin-top:8px;">${rows}</table>` : ""}
      <p style="font-size:12px;color:#94a3b8;margin:22px 0 0;">${escapeHtml(footerNote ?? translate(lang, "email.footer"))}</p>
    </div>
  </div>`;
}

/** Result of one outbox flush. `skipped`/`stopped` are additive, never removed. */
export interface FlushResult {
  attempted: number;
  sent: number;
  failed: number;
  remaining: number;
  /** Rows still queued because the invocation ran out of time, not because they failed. */
  skipped: number;
  /** `"budget"` when the loop stopped early to answer in time; otherwise null. */
  stopped: "budget" | null;
}

/** Time one send may need; below this the flush stops instead of starting it. */
const MIN_SEND_BUDGET_MS = Math.max(1_000, config.smtpTimeoutMs);

/**
 * Final tally. It runs AFTER the sends, so the budget may already be gone — a
 * missing count must not turn a successful flush into a 504.
 */
async function safeCounts(): Promise<{ pending: number; sent: number; failed: number }> {
  try {
    return await outboxRepo.counts();
  } catch {
    return { pending: 0, sent: 0, failed: 0 };
  }
}

export const emailService = {
  /**
   * Deliver one message. Never throws: mail is a side effect, and a broken SMTP
   * configuration must not fail the request that triggered it.
   */
  async send(input: { to: string; subject: string; html: string; text?: string }): Promise<{ queued: boolean; sent: boolean; reason?: string }> {
    const to = String(input.to || "").trim();
    if (!to || !to.includes("@")) return { queued: false, sent: false, reason: "NO_RECIPIENT" };

    const settings = await resolveSmtpSettings();
    if (!settings.enabled || !settings.host) {
      // Disabled on purpose (no SMTP configured): log and move on. Queueing here
      // would grow the outbox forever with mail nothing is allowed to send.
      logger.info("email: SMTP disabled — message not queued", { to: maskEmail(to), subject: input.subject });
      return { queued: false, sent: false, reason: "SMTP_DISABLED" };
    }

    const id = await outboxRepo.enqueue({ to, subject: input.subject, html: input.html, text: input.text ?? null });
    try {
      await smtpService.sendMail(to, input.subject, input.html, input.text);
      await outboxRepo.markSent(id);
      await contentRepo.logEmail(to, input.subject, "sent", null).catch(() => {});
      return { queued: true, sent: true };
    } catch (err) {
      const message = (err as Error)?.message || String(err);
      await outboxRepo.markFailed(id, message).catch(() => {});
      await contentRepo.logEmail(to, input.subject, "failed", message).catch(() => {});
      logger.warn("email: send failed — queued for retry", { to: maskEmail(to), subject: input.subject, err: message });
      return { queued: true, sent: false, reason: message };
    }
  },

  /**
   * Retry everything the outbox still owes. Returns a summary.
   *
   * This loop is bounded by the INVOCATION, not just by each send. It used to run
   * up to 50 sequential `sendMail()` calls in one request, each allowed ~24 s by
   * nodemailer's three stacked phase timeouts — hundreds of seconds inside a
   * function the platform kills at 10 s, i.e. a guaranteed
   * `FUNCTION_INVOCATION_TIMEOUT`. It now stops between messages when the budget
   * runs low; unclaimed rows stay queued and the next flush (or cron) picks them
   * up, so nothing is lost and `skipped` says how much was left.
   */
  async flush(limit = 10): Promise<FlushResult> {
    const settings = await resolveSmtpSettings();
    if (!settings.enabled || !settings.host) {
      return { attempted: 0, sent: 0, failed: 0, remaining: (await safeCounts()).pending, skipped: 0, stopped: null };
    }
    const rows = await outboxRepo.claimNext(limit);
    let sent = 0;
    let failed = 0;
    let attempted = 0;
    let stopped: FlushResult["stopped"] = null;

    for (const row of rows) {
      // Check BEFORE starting a send: a message we cannot finish would only burn
      // the time the response still needs. One send can legitimately take the
      // whole per-phase budget, so require that much before starting another.
      if (budgetExhausted(MIN_SEND_BUDGET_MS)) {
        stopped = "budget";
        logger.warn("email: outbox flush stopped early — invocation budget nearly exhausted", {
          attempted,
          queued: rows.length,
        });
        break;
      }
      attempted += 1;
      try {
        await smtpService.sendMail(row.to_email, row.subject, row.html, row.text ?? undefined);
        await outboxRepo.markSent(row.id);
        sent += 1;
      } catch (err) {
        await outboxRepo.markFailed(row.id, (err as Error)?.message || String(err)).catch(() => {});
        failed += 1;
      }
    }

    const counts = await safeCounts();
    return { attempted, sent, failed, remaining: counts.pending, skipped: rows.length - attempted, stopped };
  },

  async stats() {
    return outboxRepo.counts();
  },

  // ------------------------------ templates ------------------------------

  async welcome(userId: string, lang?: string | null): Promise<void> {
    const user = await userRepo.findById(userId);
    if (!user) return;
    const l: Lang = normalizeLang(lang ?? user.language) ?? "en";
    await this.send({
      to: user.email,
      subject: translate(l, "email.welcome.subject", { name: user.name }),
      html: layout({
        lang: l,
        title: translate(l, "email.welcome.subject", { name: user.name }),
        paragraphs: [escapeHtml(translate(l, "email.welcome.body"))],
      }),
      text: translate(l, "email.welcome.body"),
    });
  },

  async passwordReset(user: { id: string; name: string; email: string; language?: string }, link: string, minutes: number, lang?: string | null): Promise<void> {
    const l: Lang = normalizeLang(lang ?? user.language) ?? "en";
    await this.send({
      to: user.email,
      subject: translate(l, "email.reset.subject"),
      html: layout({
        lang: l,
        title: translate(l, "email.reset.subject"),
        paragraphs: [
          escapeHtml(translate(l, "email.reset.body", { minutes })),
          `<a href="${escapeHtml(link)}" style="color:#e31b23;word-break:break-all;">${escapeHtml(link)}</a>`,
          escapeHtml(translate(l, "email.reset.ignore")),
        ],
        cta: { href: link, label: translate(l, "email.reset.cta") },
      }),
      text: `${translate(l, "email.reset.body", { minutes })}\n\n${link}`,
    });
  },

  async emailVerification(user: { email: string; name: string; language?: string }, link: string, hours: number, lang?: string | null): Promise<void> {
    const l: Lang = normalizeLang(lang ?? user.language) ?? "en";
    await this.send({
      to: user.email,
      subject: translate(l, "email.verify.subject"),
      html: layout({
        lang: l,
        title: translate(l, "email.verify.subject"),
        paragraphs: [
          escapeHtml(translate(l, "email.verify.body", { hours })),
          `<a href="${escapeHtml(link)}" style="color:#e31b23;word-break:break-all;">${escapeHtml(link)}</a>`,
        ],
        cta: { href: link, label: translate(l, "email.verify.cta") },
      }),
      text: `${translate(l, "email.verify.body", { hours })}\n\n${link}`,
    });
  },

  async securityNotice(user: { email: string; language?: string }, key: "email.password_changed.subject" | "email.new_login.subject", date: string, lang?: string | null): Promise<void> {
    const l: Lang = normalizeLang(lang ?? user.language) ?? "en";
    const bodyKey = key === "email.password_changed.subject" ? "email.password_changed.body" : "email.new_login.body";
    await this.send({
      to: user.email,
      subject: translate(l, key),
      html: layout({ lang: l, title: translate(l, key), paragraphs: [escapeHtml(translate(l, bodyKey, { date }))] }),
      text: translate(l, bodyKey, { date }),
    });
  },

  /** Order confirmation — replaces the old inline HTML in smtp.service. */
  async orderConfirmation(orderId: string): Promise<void> {
    const order = await orderRepo.findById(orderId);
    if (!order) return;
    const user = order.user_id ? await userRepo.findById(order.user_id) : null;
    const l: Lang = normalizeLang(user?.language) ?? "en";
    const items = await orderRepo.items(orderId);
    const lines = items.map((i) => ({ label: `${i.product_name} × ${i.qty}`, value: `৳${(Number(i.price) * Number(i.qty)).toFixed(2)}` }));
    lines.push({ label: "Subtotal", value: `৳${Number(order.subtotal).toFixed(2)}` });
    lines.push({ label: "Delivery", value: `৳${Number(order.delivery_fee).toFixed(2)}` });
    lines.push({ label: "Total", value: `৳${Number(order.total).toFixed(2)}` });

    await this.send({
      to: user?.email ?? "",
      subject: translate(l, "email.order.subject", { id: order.id }),
      html: layout({
        lang: l,
        title: translate(l, "email.order.subject", { id: order.id }),
        paragraphs: [escapeHtml(translate(l, "email.order.body", { name: order.customer_name }))],
        table: [...lines, { label: "Payment", value: `${order.payment_method} · ${order.payment_status}` }],
      }),
      text: `${translate(l, "email.order.body", { name: order.customer_name })}\nOrder ${order.id}\nTotal ৳${Number(order.total).toFixed(2)}`,
    });
  },

  async orderStatus(orderId: string, status: string): Promise<void> {
    const order = await orderRepo.findById(orderId);
    if (!order) return;
    const user = order.user_id ? await userRepo.findById(order.user_id) : null;
    const l: Lang = normalizeLang(user?.language) ?? "en";
    await this.send({
      to: user?.email ?? "",
      subject: translate(l, "email.order.subject", { id: order.id }),
      html: layout({
        lang: l,
        title: translate(l, "email.order.subject", { id: order.id }),
        paragraphs: [escapeHtml(translate(l, "email.order.status", { id: order.id, status }))],
      }),
      text: translate(l, "email.order.status", { id: order.id, status }),
    });
  },

  async paymentConfirmed(orderId: string, amount: number): Promise<void> {
    const order = await orderRepo.findById(orderId);
    if (!order) return;
    const user = order.user_id ? await userRepo.findById(order.user_id) : null;
    const l: Lang = normalizeLang(user?.language) ?? "en";
    await this.send({
      to: user?.email ?? "",
      subject: translate(l, "email.payment.subject", { id: order.id }),
      html: layout({
        lang: l,
        title: translate(l, "email.payment.subject", { id: order.id }),
        paragraphs: [escapeHtml(translate(l, "email.payment.body", { id: order.id, amount: `৳${Number(amount).toFixed(2)}` }))],
      }),
      text: translate(l, "email.payment.body", { id: order.id, amount: `৳${amount}` }),
    });
  },

  async bloodRequestPosted(email: string, params: { units: number; group: string }, lang?: string | null): Promise<void> {
    const l: Lang = normalizeLang(lang) ?? "en";
    await this.send({
      to: email,
      subject: translate(l, "email.request.subject"),
      html: layout({
        lang: l,
        title: translate(l, "email.request.subject"),
        paragraphs: [escapeHtml(translate(l, "email.request.body", params))],
      }),
      text: translate(l, "email.request.body", params),
    });
  },

  async messageReply(to: string, subject: string, body: string, lang?: string | null): Promise<void> {
    const l: Lang = normalizeLang(lang) ?? "en";
    await this.send({
      to,
      subject: translate(l, "email.reply.subject", { subject }),
      html: layout({
        lang: l,
        title: translate(l, "email.reply.subject", { subject }),
        paragraphs: [escapeHtml(body).replace(/\n/g, "<br>")],
      }),
      text: body,
    });
  },

  /** Alert to the site mailbox (new order, new chat message, …). */
  async adminAlert(title: string, body: string): Promise<void> {
    const settings = await resolveSmtpSettings();
    const to = settings.fromEmail || settings.user;
    if (!to) return;
    await this.send({
      to,
      subject: translate("en", "email.admin.subject", { title }),
      html: layout({ lang: "en", title, paragraphs: [escapeHtml(body).replace(/\n/g, "<br>")] }),
      text: body,
    });
  },
};
