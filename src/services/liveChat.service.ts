import { liveChatRepo, type LiveMessageOut } from "../repos/liveChat.repo.js";
import { userRepo } from "../repos/user.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { loadSettings } from "./meta.service.js";
import { notificationService } from "./notification.service.js";
import { emailService } from "./email.service.js";
import { translate } from "../i18n/index.js";
import { ApiError, randomId } from "../utils/errors.js";
import { str } from "../utils/validate.js";
import { logger } from "../utils/logger.js";
import type { SafeUser } from "../types.js";

/**
 * Live Messaging (human support) — any visitor (guest or logged-in) can chat
 * with the admin team. Sessions are opaque session_keys in the database; the
 * "real-time" channels are SSE connections that poll the DB (serverless-safe:
 * no in-process fan-out, so any instance can serve any conversation).
 *
 * DUPLICATE MESSAGES
 * ------------------
 * Three separate mechanisms, because "the client shows my message twice" has
 * three separate causes:
 *
 *  1. **Idempotent creation** (this file + `liveChatRepo.add`). The client may
 *     send `client_message_id`; a UNIQUE (session_key, client_message_id) index
 *     plus a reconcile-on-conflict path means a retried POST, a replayed send
 *     after a reconnect, or a double-clicked button stores ONE row. The response
 *     carries `duplicate: true` so the client can tell "created" from
 *     "already had it". Deduplication is by client id — never by message text,
 *     which would silently swallow a legitimate repeated "yes".
 *
 *  2. **Stable, monotonic ids**. Each message's public id is its numeric rowid,
 *     assigned once by the database and never reused, so a client can reconcile
 *     with `id <= lastSeen` and with the `client_message_id` it generated.
 *
 *  3. **A single delivery path per cursor**. The SSE stream and the polling
 *     fallback both advance on the same rowid cursor, so a reconnect resumes
 *     where it stopped instead of replaying history.
 *
 * What the backend cannot fix is a client that renders an optimistic bubble and
 * then also renders the server echo without reconciling by id — that duplicate
 * exists only in the DOM. The API gives the client everything it needs to
 * reconcile (`id`, `client_message_id`, `duplicate`); the frontend widget should
 * key its bubbles by `client_message_id` when it has one.
 */

const GREETING_KEY = "chat.greeting";

function shapeMessage(m: LiveMessageOut) {
  return {
    id: m.rowid,
    session_key: m.session_key,
    sender_type: m.sender_type,
    sender_name: m.sender_name,
    body: m.body,
    // Echoed so a client can match its own optimistic bubble to the stored row.
    client_message_id: m.client_message_id ?? null,
    created_at: m.created_at,
  };
}

export type ShapedMessage = ReturnType<typeof shapeMessage>;

/** Client-supplied idempotency key (any of these names is accepted). */
export function clientMessageId(body: Record<string, unknown>): string | null {
  const raw =
    str(body.client_message_id) ??
    str(body.clientMessageId) ??
    str(body.client_id) ??
    str(body.idempotency_key) ??
    str(body.message_id);
  if (!raw) return null;
  // Bound the length: it is indexed and comes from the browser.
  return raw.slice(0, 120);
}

export const liveChatService = {
  async enabled(): Promise<boolean> {
    const s = await loadSettings();
    return s.live_chat_enabled === 1;
  },

  /** POST /api/support/session — start or resume a conversation. */
  async startSession(opts: { key?: string; name?: string; user?: SafeUser | null; lang?: string | null }) {
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
      greeting: translate(opts.lang, GREETING_KEY),
      // The cursor the client should resume from — lets a reconnect avoid
      // replaying history instead of resetting to 0.
      last_message_id: messages.length ? messages[messages.length - 1].rowid : 0,
    };
  },

  /** GET /api/support/messages?session=&after=<rowid>. */
  async messages(key: string, afterRowid: number | null) {
    if (!key) throw ApiError.badRequest("Missing session.", "SESSION_REQUIRED");
    const rows = await liveChatRepo.since(key, afterRowid, 200);
    await liveChatRepo.resetUnread(key, "visitor");
    return { success: true, messages: rows.map(shapeMessage), last_message_id: rows.length ? rows[rows.length - 1].rowid : afterRowid ?? 0 };
  },

  /**
   * POST /api/support/messages — visitor sends a message.
   * Idempotent when `client_message_id` is supplied.
   */
  async send(opts: { key?: string; name?: string; user?: SafeUser | null; body?: string; clientMessageId?: string | null; lang?: string | null }) {
    const body = str(opts.body) || "";
    if (!body) throw ApiError.badRequest(translate(opts.lang, "chat.empty"), "EMPTY_MESSAGE");
    if (body.length > 2000) throw ApiError.badRequest(translate(opts.lang, "chat.too_long", { max: 2000 }), "MESSAGE_TOO_LONG");

    let key = (opts.key || "").trim();
    let session = key ? await liveChatRepo.findByKey(key) : null;
    if (!session) {
      key = randomId(18);
      const visitorName = opts.user ? opts.user.name : (str(opts.name) ?? "").slice(0, 60) || "Guest";
      session = await liveChatRepo.create(key, opts.user?.id ?? null, visitorName);
    }
    if (session.is_open !== 1) throw ApiError.badRequest(translate(opts.lang, "chat.closed"), "CONVERSATION_CLOSED");

    const senderName = opts.user ? opts.user.name : session.visitor_name || "Guest";
    const { row, duplicate } = await liveChatRepo.add(key, "visitor", senderName, body, opts.clientMessageId ?? null);

    if (duplicate) {
      // Already stored (retry / double submit / replayed send). Touch nothing:
      // no second activity row, no second unread bump, no second email.
      return { success: true, session_key: key, message: shapeMessage(row), duplicate: true };
    }

    await liveChatRepo.lastActivity(key, body);
    await liveChatRepo.bumpUnread(key, "admin");
    await activityRepo.create("chat", null, `${senderName} messaged the support desk`, { session_key: key });

    // Notify the admin desk (bell) and, when SMTP is on, the site mailbox.
    notificationService.emitAsync({
      event: "admin_chat",
      toAdmins: true,
      params: { name: senderName },
      entityType: "live_session",
      entityId: key,
      link: "/admin/live-chat",
      dedupeKey: `chat:${row.id}`,
    });

    // Best-effort mail alert through the durable outbox — never awaited by the
    // response path beyond enqueueing, and never able to fail the send.
    void (async () => {
      try {
        const s = await loadSettings();
        if (s.smtp_enabled === 1) {
          await emailService.adminAlert(`New live-chat message from ${senderName}`, body);
        }
      } catch (err) {
        logger.debug("chat: admin alert skipped", { err: String((err as Error)?.message ?? err) });
      }
    })();

    return { success: true, session_key: key, message: shapeMessage(row), duplicate: false };
  },

  /** New visitor messages for the visitor SSE channel (rowid cursor). */
  async pollSession(key: string, afterRowid: number): Promise<{ messages: ShapedMessage[]; closed: boolean }> {
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
    // One query for every referenced user instead of N (the old code issued a
    // findById per session — an N+1 on the busiest admin screen).
    const ids = [...new Set(sessions.map((s) => s.user_id).filter(Boolean))] as string[];
    const users = new Map<string, { id: string; name: string }>();
    for (const id of ids) {
      const u = await userRepo.findById(id);
      if (u) users.set(id, { id: u.id, name: u.name });
    }
    const withUsers = sessions.map((s) => ({
      ...s,
      user: s.user_id ? users.get(s.user_id) ?? null : null,
      online: false, // serverless: no in-process presence tracking
    }));
    return { success: true, sessions: withUsers, unread_total };
  },

  async adminMessages(key: string) {
    const session = await liveChatRepo.findByKey(key);
    if (!session) throw ApiError.notFound("Conversation not found.", "SESSION_NOT_FOUND");
    const messages = await liveChatRepo.since(key, null, 500);
    await liveChatRepo.resetUnread(key, "admin");
    return { success: true, session, messages: messages.map(shapeMessage) };
  },

  async adminReply(actor: SafeUser, key: string, body: string, opts: { clientMessageId?: string | null; lang?: string | null } = {}) {
    const session = await liveChatRepo.findByKey(key);
    if (!session) throw ApiError.notFound("Conversation not found.", "SESSION_NOT_FOUND");
    const text = body.trim();
    if (!text) throw ApiError.badRequest(translate(opts.lang, "chat.empty"), "EMPTY_MESSAGE");

    const { row, duplicate } = await liveChatRepo.add(key, "admin", actor.name, text, opts.clientMessageId ?? null);
    if (duplicate) {
      return { success: true, message: shapeMessage(row), duplicate: true, message2: "ℹ️ Reply already sent." };
    }

    await liveChatRepo.lastActivity(key, text);
    await liveChatRepo.resetUnread(key, "admin");
    await liveChatRepo.bumpUnread(key, "visitor");
    await activityRepo.create("chat_reply", actor.id, "Replied in live support chat", { session_key: key });
    return { success: true, message: shapeMessage(row), duplicate: false, message2: "✅ Reply sent live." };
  },

  async adminClose(key: string) {
    await liveChatRepo.setOpen(key, false);
    return { success: true, message: "ℹ️ Conversation closed." };
  },

  /** Admin SSE channel: poll for session activity since the cursor time. */
  async pollAdminActivity(sinceIso: string) {
    const changes = await liveChatRepo.activitySince(sinceIso);
    const out: { session_key: string; visitor_name: string; message: ShapedMessage | null; closed: boolean }[] = [];
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
