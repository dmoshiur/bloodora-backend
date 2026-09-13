import { liveChatRepo, type LiveMessageOut } from "../repos/liveChat.repo.js";
import { userRepo } from "../repos/user.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { loadSettings } from "./meta.service.js";
import { ApiError, randomId } from "../utils/errors.js";
import { str } from "../utils/validate.js";
import type { SafeUser } from "../types.js";

/**
 * Live Messaging (human support) — any visitor (guest or logged-in) can chat
 * with the admin team. Sessions are opaque session_keys in the database; the
 * "real-time" channels are SSE connections that poll the DB (serverless-safe:
 * no in-process fan-out, so any instance can serve any conversation).
 */

const GREETING =
  "Assalamu alaikum! This is the BloodOra live support desk. A human from the admin team will answer — usually within a few minutes. For urgent blood, please also post a request.";

function shapeMessage(m: LiveMessageOut) {
  return {
    id: m.rowid,
    session_key: m.session_key,
    sender_type: m.sender_type,
    sender_name: m.sender_name,
    body: m.body,
    created_at: m.created_at,
  };
}

export const liveChatService = {
  async enabled(): Promise<boolean> {
    const s = await loadSettings();
    return s.live_chat_enabled === 1;
  },

  /** POST /api/support/session — start or resume a conversation. */
  async startSession(opts: { key?: string; name?: string; user?: SafeUser | null }) {
    let key = (opts.key || "").trim();
    let session = key ? await liveChatRepo.findByKey(key) : null;
    if (!session || session.is_open !== 1) {
      key = randomId(18);
      const visitorName = opts.user ? opts.user.name : (str(opts.name) ?? "").slice(0, 60) || "Guest";
      session = await liveChatRepo.create(key, opts.user?.id ?? null, visitorName);
    }
    // If the visitor later logs in (or sends a name), keep the display name fresh.
    const freshName = opts.user ? opts.user.name : str(opts.name);
    if (freshName && session.visitor_name === "Guest" && freshName !== "Guest") {
      await liveChatRepo.updateVisitorName(key, freshName.slice(0, 60));
    }
    const messages = await liveChatRepo.since(key, null, 200);
    await liveChatRepo.resetUnread(key, "visitor");
    return {
      success: true,
      session_key: key,
      visitor_name: session.visitor_name,
      enabled: true,
      messages: messages.map(shapeMessage),
      greeting: GREETING,
    };
  },

  /** GET /api/support/messages?session=&after=<rowid>. */
  async messages(key: string, afterRowid: number | null) {
    if (!key) throw ApiError.badRequest("Missing session.", "SESSION_REQUIRED");
    const rows = await liveChatRepo.since(key, afterRowid, 200);
    await liveChatRepo.resetUnread(key, "visitor");
    return { success: true, messages: rows.map(shapeMessage) };
  },

  /** POST /api/support/messages — visitor sends a message. */
  async send(opts: { key?: string; name?: string; user?: SafeUser | null; body?: string }) {
    const body = str(opts.body) || "";
    if (!body) throw ApiError.badRequest("❌ Message cannot be empty.", "EMPTY_MESSAGE");
    if (body.length > 2000) throw ApiError.badRequest("❌ Message too long (max 2000 characters).", "MESSAGE_TOO_LONG");

    let key = (opts.key || "").trim();
    let session = key ? await liveChatRepo.findByKey(key) : null;
    if (!session) {
      key = randomId(18);
      const visitorName = opts.user ? opts.user.name : (str(opts.name) ?? "").slice(0, 60) || "Guest";
      session = await liveChatRepo.create(key, opts.user?.id ?? null, visitorName, );
    }
    if (session.is_open !== 1) throw ApiError.badRequest("This conversation is closed.", "CONVERSATION_CLOSED");

    const senderName = opts.user ? opts.user.name : session.visitor_name || "Guest";
    const row = await liveChatRepo.add(key, "visitor", senderName, body);
    await liveChatRepo.lastActivity(key, body);
    await liveChatRepo.bumpUnread(key, "admin");
    await activityRepo.create("chat", null, `${senderName} messaged the support desk`, { session_key: key });

    // Optional email alert to the admin team (fire and forget, best effort).
    void (async () => {
      try {
        const s = await loadSettings();
        if (s.smtp_enabled === 1 && s.smtp_from_email) {
          const { smtpService } = await import("./smtp.service.js");
          await smtpService.sendMail(
            s.site_email || s.smtp_from_email,
            `[BloodOra] New live-chat message from ${senderName}`,
            `<p>${escapeHtml(body)}</p>`,
          );
        }
      } catch {
        /* alerts are best-effort */
      }
    })();

    return { success: true, session_key: key, message: shapeMessage(row) };
  },

  /** New visitor messages for the visitor SSE channel (rowid cursor). */
  async pollSession(key: string, afterRowid: number): Promise<{ messages: ReturnType<typeof shapeMessage>[]; closed: boolean }> {
    const rows = await liveChatRepo.since(key, afterRowid, 200);
    const session = await liveChatRepo.findByKey(key);
    return {
      messages: rows.map(shapeMessage),
      closed: session ? session.is_open !== 1 : true,
    };
  },

  // ---------- admin side ----------

  async adminSessions() {
    const sessions = await liveChatRepo.openSessions(200);
    const unread_total = await liveChatRepo.unreadAdminTotal();
    const withUsers = await Promise.all(
      sessions.map(async (s) => {
        const user = s.user_id ? await userRepo.findById(s.user_id) : null;
        return {
          ...s,
          user: user ? { id: user.id, name: user.name } : null,
          online: false, // serverless: no in-process presence tracking
        };
      }),
    );
    return { success: true, sessions: withUsers, unread_total };
  },

  async adminMessages(key: string) {
    const session = await liveChatRepo.findByKey(key);
    if (!session) throw ApiError.notFound("Conversation not found.", "SESSION_NOT_FOUND");
    const messages = await liveChatRepo.since(key, null, 500);
    await liveChatRepo.resetUnread(key, "admin");
    return { success: true, session, messages: messages.map(shapeMessage) };
  },

  async adminReply(actor: SafeUser, key: string, body: string) {
    const session = await liveChatRepo.findByKey(key);
    if (!session) throw ApiError.notFound("Conversation not found.", "SESSION_NOT_FOUND");
    const text = body.trim();
    if (!text) throw ApiError.badRequest("❌ Reply cannot be empty.", "EMPTY_MESSAGE");

    const row = await liveChatRepo.add(key, "admin", actor.name, text);
    await liveChatRepo.lastActivity(key, text);
    await liveChatRepo.resetUnread(key, "admin");
    await liveChatRepo.bumpUnread(key, "visitor");
    await activityRepo.create("chat_reply", actor.id, "Replied in live support chat", { session_key: key });
    return { success: true, message: shapeMessage(row), message2: "✅ Reply sent live." };
  },

  async adminClose(key: string) {
    await liveChatRepo.setOpen(key, false);
    return { success: true, message: "ℹ️ Conversation closed." };
  },

  /** Admin SSE channel: poll for session activity since the cursor time. */
  async pollAdminActivity(sinceIso: string) {
    const changes = await liveChatRepo.activitySince(sinceIso);
    const out: { session_key: string; visitor_name: string; message: ReturnType<typeof shapeMessage> | null; closed: boolean }[] = [];
    for (const c of changes) {
      const lastRowid = await liveChatRepo.lastRowid(c.key);
      const rows = lastRowid ? await liveChatRepo.since(c.key, lastRowid - 1, 1) : [];
      const session = await liveChatRepo.findByKey(c.key);
      out.push({
        session_key: c.key,
        visitor_name: session?.visitor_name ?? "Guest",
        message: rows.length ? shapeMessage(rows[rows.length - 1]) : null,
        closed: session ? session.is_open !== 1 : false,
      });
    }
    return out;
  },
};

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
