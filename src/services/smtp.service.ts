import nodemailer from "nodemailer";
import { contentRepo } from "../repos/content.repo.js";
import { settingsRepo } from "../repos/settings.repo.js";
import { orderRepo } from "../repos/order.repo.js";
import { userRepo } from "../repos/user.repo.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { maskEmail } from "../utils/errors.js";
import { withTimeout } from "../db/timeout.js";
import { budgetExhausted } from "../utils/deadline.js";

export interface SmtpSettings {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromName: string;
  fromEmail: string;
}

/** DB settings override env defaults; env is the fallback. */
export async function resolveSmtpSettings(): Promise<SmtpSettings> {
  const db = await settingsRepo.all();
  const env = config.smtp;
  return {
    enabled: db.smtp_enabled !== undefined ? ["1", "true", "yes", "on"].includes(db.smtp_enabled) : env.enabled,
    host: db.smtp_host || env.host,
    port: db.smtp_port !== undefined && db.smtp_port !== "" ? Number(db.smtp_port) : env.port,
    secure: ["1", "true", "yes", "on"].includes(db.smtp_secure),
    user: db.smtp_user || env.user,
    pass: db.smtp_pass || env.pass,
    fromName: db.smtp_from_name || env.fromName,
    fromEmail: db.smtp_from_email || env.fromEmail,
  };
}

let transporterCache: { key: string; transporter: nodemailer.Transporter } | null = null;

function transporterFor(s: SmtpSettings): nodemailer.Transporter {
  const key = [s.host, s.port, s.secure, s.user, s.fromEmail].join("|");
  if (transporterCache && transporterCache.key === key) return transporterCache.transporter;
  const transporter = nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.secure,
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    // Socket deadlines. nodemailer defaults are effectively "wait for the OS",
    // so a mail host that accepts the TCP connection and then goes silent held
    // `sendMail()` — and therefore the whole outbox flush, and the
    // /api/admin/smtp/test request that triggered it — open indefinitely. SMTP is
    // never allowed to be the reason an unrelated API call stalls.
    connectionTimeout: config.smtpTimeoutMs,
    greetingTimeout: config.smtpTimeoutMs,
    socketTimeout: config.smtpTimeoutMs,
  });
  transporterCache = { key, transporter };
  return transporter;
}

/**
 * Bound one whole send.
 *
 * nodemailer's `connectionTimeout`, `greetingTimeout` and `socketTimeout` are
 * three SEQUENTIAL phases, so a per-phase value of 8 s was really up to 24 s for a
 * single message — and `email.service.flush()` sends up to 50 of them in a loop
 * inside one invocation. With the per-phase value now clamped to a third of the
 * function budget (see `config/env.ts`), this bounds the sum as well, and
 * `withTimeout` clamps it further to whatever the current request has left.
 */
function sendTimeoutMs(): number {
  return config.smtpTimeoutMs * 3;
}

export const smtpService = {
  async sendMail(to: string, subject: string, html: string, text?: string): Promise<void> {
    const s = await resolveSmtpSettings();
    if (!s.enabled || !s.host) {
      logger.info("smtp: disabled — skipping mail (log only)", { to: maskEmail(to), subject });
      return;
    }
    await withTimeout(
      transporterFor(s).sendMail({
        from: `"${s.fromName}" <${s.fromEmail}>`,
        to,
        subject,
        html,
        text: text || undefined,
      }),
      sendTimeoutMs(),
      "SMTP send",
      "SMTP_TIMEOUT",
    );
    logger.info("smtp: mail sent", { to: maskEmail(to), subject });
  },

  /**
   * POST /api/admin/smtp/test — real round-trip; reports the true error.
   * Original mailer.testSmtp() contract.
   */
  async test(toOverride?: string): Promise<{ sent: boolean; message: string; info?: unknown; error?: string }> {
    const s = await resolveSmtpSettings();
    const to = (toOverride || s.fromEmail || s.user || "").trim();
    if (!to) return { sent: false, message: "❌ No recipient address. Enter a test address or set the From address first." };
    if (!s.host) return { sent: false, message: "❌ SMTP host is empty — save the settings first." };
    const subject = `✅ ${s.fromName} SMTP test successful`;
    const text = `This is a test email from ${s.fromName}.\n\nServer: ${s.host}:${s.port}\nSecure (TLS): ${s.secure ? "yes" : "no (STARTTLS/opportunistic)"}\nUsername: ${s.user || "(none)"}\nSent at: ${new Date().toISOString()}\n\nIf you received this, your Admin Panel SMTP settings are working.`;
    const html = `<div style="font-family:Georgia,serif;max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#e31b23,#ff3340);color:#fff;padding:22px 26px;">
          <div style="font-size:22px;font-weight:700;">${s.fromName}</div>
          <div style="opacity:.9;">SMTP configuration test</div>
        </div>
        <div style="padding:26px;color:#0f172a;">
          <p style="font-size:16px;margin:0 0 14px;"><strong>✅ Success!</strong> Your SMTP settings are working correctly.</p>
          <table style="width:100%;font-size:13px;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:#64748b;">Host</td><td style="padding:6px 0;text-align:right;">${s.host}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;">Port</td><td style="padding:6px 0;text-align:right;">${s.port}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;">TLS / Secure</td><td style="padding:6px 0;text-align:right;">${s.secure ? "yes" : "no"}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;">Username</td><td style="padding:6px 0;text-align:right;">${s.user || "(none)"}</td></tr>
            <tr><td style="padding:6px 0;color:#64748b;">Sent at</td><td style="padding:6px 0;text-align:right;">${new Date().toISOString()}</td></tr>
          </table>
        </div>
      </div>`;
    try {
      const transporter = transporterFor(s);
      // verify() opens its own connection, so it gets its own bound; the two
      // phases together must still fit inside the invocation.
      await withTimeout(
        Promise.resolve((transporter as nodemailer.Transporter & { verify?: () => Promise<unknown> }).verify?.()),
        sendTimeoutMs(),
        "SMTP verify",
        "SMTP_TIMEOUT",
      );
      if (budgetExhausted(500)) {
        const message = "SMTP connect succeeded, but the request ran out of time before the message could be sent. Try again.";
        await contentRepo.logEmail(to, "SMTP test", "failed", message).catch(() => {});
        return { sent: false, message: `⚠️ ${message}`, error: message };
      }
      const info = await withTimeout(
        transporter.sendMail({
          from: `"${s.fromName || "BloodOra"} <${s.fromEmail || s.user}>"`,
          to,
          subject,
          text,
          html,
        }),
        sendTimeoutMs(),
        "SMTP send",
        "SMTP_TIMEOUT",
      );
      await contentRepo.logEmail(to, "SMTP test", "sent", null);
      return { sent: true, message: `✅ Test email sent to ${to}. Check the inbox (and spam folder).`, info };
    } catch (e) {
      const message = (e as Error).message;
      await contentRepo.logEmail(to, "SMTP test", "failed", message).catch(() => {});
      return { sent: false, message: "❌ SMTP test failed: " + message, error: message };
    }
  },

  async sendOrderConfirmation(orderId: string): Promise<void> {
    const order = await orderRepo.findById(orderId);
    if (!order) return;
    const items = await orderRepo.items(orderId);
    const lines = items
      .map((i) => `<tr><td style="padding:4px 0">${i.product_name} × ${i.qty}</td><td align="right">৳${(i.price * i.qty).toFixed(2)}</td></tr>`)
      .join("");
    const html = `
      <div style="font-family:sans-serif">
        <h2 style="color:#c62828">BloodOra — Order ${order.id}</h2>
        <p>Thank you, ${order.customer_name}! Your order is being processed.</p>
        <table style="border-collapse:collapse;width:100%;max-width:480px">
          ${lines}
          <tr><td colspan="2" style="border-top:1px solid #ddd;padding-top:8px;font-weight:bold">Subtotal</td><td align="right">৳${order.subtotal.toFixed(2)}</td></tr>
          <tr><td>Delivery</td><td align="right">৳${order.delivery_fee.toFixed(2)}</td></tr>
          <tr><td style="font-weight:bold">Total</td><td align="right" style="font-weight:bold">৳${order.total.toFixed(2)}</td></tr>
        </table>
        <p>Payment: <b>${order.payment_method}</b> — Status: <b>${order.status}</b></p>
        <p style="color:#777">Address: ${order.address}, ${order.city}</p>
      </div>`;
    const email = await orderUserEmail(order.user_id);
    if (!email) return;
    await this.sendMail(email, `BloodOra order ${order.id} confirmed`, html);
  },
};

async function orderUserEmail(userId: string): Promise<string | null> {
  const u = await userRepo.findById(userId);
  return u?.email ?? null;
}
