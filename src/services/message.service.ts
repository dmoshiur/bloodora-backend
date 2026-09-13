import { messageRepo } from "../repos/message.repo.js";
import { userRepo } from "../repos/user.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { ApiError } from "../utils/errors.js";
import { str } from "../utils/validate.js";
import type { MessageRow, SafeUser } from "../types.js";

const ADMIN_RECIPIENT = "admin";

export interface MessageView {
  id: string;
  sender_id: string;
  recipient_id: string;
  subject: string;
  content: string;
  is_read: number;
  is_admin_message: number;
  replied_to: string | null;
  created_at: string;
  sender_name: string | null;
  recipient_name: string | null;
}

async function withNames(row: MessageRow): Promise<MessageView> {
  const [sender, recipient] = await Promise.all([
    row.sender_id === ADMIN_RECIPIENT ? Promise.resolve(null) : userRepo.findById(row.sender_id),
    row.recipient_id === ADMIN_RECIPIENT ? Promise.resolve(null) : userRepo.findById(row.recipient_id),
  ]);
  return {
    id: row.id,
    sender_id: row.sender_id,
    recipient_id: row.recipient_id,
    subject: row.subject,
    content: row.body,
    is_read: row.read_at ? 1 : 0,
    is_admin_message: row.is_admin_message,
    replied_to: row.replied_to,
    created_at: row.created_at,
    sender_name: row.sender_id === ADMIN_RECIPIENT ? "Admin" : sender?.name ?? null,
    recipient_name:
      row.recipient_id === ADMIN_RECIPIENT ? "Admin" : recipient?.name ?? null,
  };
}

/**
 * User↔admin (or user↔user) messaging. A message without a recipient_email
 * is addressed to the admin desk (recipient 'admin').
 */
export const messageService = {
  /** GET /api/messages — inbox for the current user. */
  async inbox(user: SafeUser) {
    const [receivedRows, sentRows, unread] = await Promise.all([
      messageRepo.inbox(user.id),
      messageRepo.sent(user.id),
      messageRepo.unreadCount(user.id),
    ]);
    const [received, sent] = await Promise.all([
      Promise.all(receivedRows.map(withNames)),
      Promise.all(sentRows.map(withNames)),
    ]);
    return { success: true, received, sent, unread_count: unread };
  },

  /** POST /api/messages — send to the desk (default) or to a user by email. */
  async send(user: SafeUser, body: Record<string, unknown>): Promise<string> {
    const subject = (str(body.subject) ?? "").trim();
    const content = (str(body.content) ?? "").trim();
    if (!subject || !content) throw ApiError.badRequest("❌ Subject and message are required.", "FIELDS_REQUIRED");

    let recipientId = ADMIN_RECIPIENT;
    let isAdmin = 1;
    const recipientEmail = (str(body.recipient_email) ?? "").trim();
    if (recipientEmail) {
      const recipient = await userRepo.findByEmail(recipientEmail);
      if (!recipient) throw ApiError.notFound("❌ Recipient not found.", "RECIPIENT_NOT_FOUND");
      // Original contract: no self-message guard (a user may message themself).
      recipientId = recipient.id;
      isAdmin = 0;
    }

    const id = await messageRepo.create(user.id, recipientId, subject, content, { isAdminMessage: isAdmin === 1 });
    await activityRepo.create("message", user.id, `New message from ${user.name}: "${subject.slice(0, 60)}"`);
    return id;
  },

  /** GET /api/messages/:id — read (marks read for the recipient). */
  async read(user: SafeUser, id: string): Promise<MessageView> {
    const row = await messageRepo.findById(id);
    if (!row) throw ApiError.notFound("Message not found.", "MESSAGE_NOT_FOUND");
    if (row.recipient_id === user.id) {
      await messageRepo.markRead([id]);
      row.read_at = row.read_at ?? new Date().toISOString();
    }
    return withNames(row);
  },

  /** GET /api/messages/:id/original — original message for the reply form. */
  async original(user: SafeUser, id: string): Promise<MessageView> {
    const row = await messageRepo.findById(id);
    if (!row) throw ApiError.notFound("Message not found.", "MESSAGE_NOT_FOUND");
    return withNames(row);
  },

  /** POST /api/messages/:id/reply */
  async reply(user: SafeUser, id: string, content: string): Promise<void> {
    const text = content.trim();
    if (!text) throw ApiError.badRequest("Reply text is required.", "REPLY_REQUIRED");
    const original = await messageRepo.findById(id);
    if (!original) throw ApiError.notFound("Message not found.", "MESSAGE_NOT_FOUND");
    await messageRepo.create(user.id, original.sender_id, `Re: ${original.subject}`, text, {
      repliedTo: original.id,
      isAdminMessage: original.sender_id === ADMIN_RECIPIENT,
    });
  },

  // ---------- admin mailbox ----------

  async adminList() {
    const [rows, unread] = await Promise.all([
      messageRepo.adminInbox(),
      messageRepo.adminUnreadCount(),
    ]);
    const messages = await Promise.all(rows.map(withNames));
    return { success: true, messages, unread };
  },

  async adminReply(actor: SafeUser, id: string, content: string): Promise<void> {
    const text = content.trim();
    if (!text) throw ApiError.badRequest("Reply text is required.", "REPLY_REQUIRED");
    const original = await messageRepo.findById(id);
    if (!original) throw ApiError.notFound("Message not found.", "MESSAGE_NOT_FOUND");
    const toUser = original.sender_id;
    await messageRepo.create(actor.id, toUser, `Re: ${original.subject}`, text, {
      isAdminMessage: true,
      isAdminReply: true,
      repliedTo: original.id,
    });
    await messageRepo.markRead([id]);
    await activityRepo.create("message_reply", actor.id, `${actor.name} replied to a user message`, { message: id });
  },
};
