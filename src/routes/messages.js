// ==================== BloodOra Backend API - Messages ====================
import express from "express";
import { get, all, run } from "../db.js";
import { requireAuth, requireAdmin } from "../auth.js";
import { tryCatch } from "../utils.js";

const router = express.Router();

// GET /api/messages — inbox (received/sent/unread) for current user
router.get("/", requireAuth, (req, res) =>
  tryCatch(res, async () => {
    const received = await all(
      `SELECT m.*, u.name as sender_name FROM messages m LEFT JOIN users u ON m.sender_id=u.id WHERE (m.recipient_id=? OR m.recipient_id IS NULL) AND m.is_admin_message=0 ORDER BY m.created_at DESC`,
      [req.user.id]
    );
    const sent = await all(
      `SELECT m.*, u.name as recipient_name FROM messages m LEFT JOIN users u ON m.recipient_id=u.id WHERE m.sender_id=? ORDER BY m.created_at DESC`,
      [req.user.id]
    );
    const unreadRow = await get(`SELECT COUNT(*) as c FROM messages WHERE recipient_id=? AND is_read=0`, [req.user.id]);
    res.json({ success: true, received, sent, unread_count: unreadRow.c });
  })
);

// POST /api/messages — send (to admin by default, or to a user by email)
router.post("/", requireAuth, (req, res) =>
  tryCatch(res, async () => {
    const { subject, content, recipient_email } = req.body;
    if (!subject || !content) {
      return res.status(400).json({ success: false, message: "❌ Subject and message are required." });
    }
    let recipient_id = null, is_admin = 1;
    if (recipient_email) {
      const recipient = await get("SELECT id FROM users WHERE email=?", [recipient_email]);
      if (!recipient) return res.status(404).json({ success: false, message: "❌ Recipient not found." });
      recipient_id = recipient.id;
      is_admin = 0;
    }
    await run(`INSERT INTO messages (sender_id, recipient_id, subject, content, is_admin_message) VALUES (?,?,?, ?,?)`, [req.user.id, recipient_id, subject, content, is_admin]);
    res.json({ success: true, message: "✅ Message sent successfully!" });
  })
);

// GET /api/messages/:id — read a message (marks read when recipient)
router.get("/:id", requireAuth, (req, res) =>
  tryCatch(res, async () => {
    const message = await get(
      `SELECT m.*, s.name as sender_name, r.name as recipient_name FROM messages m LEFT JOIN users s ON m.sender_id=s.id LEFT JOIN users r ON m.recipient_id=r.id WHERE m.id=?`,
      [req.params.id]
    );
    if (!message) return res.status(404).json({ success: false, message: "Message not found." });
    if (message.recipient_id === req.user.id || message.recipient_id === null) {
      await run("UPDATE messages SET is_read=1 WHERE id=?", [req.params.id]);
      message.is_read = 1;
    }
    res.json({ success: true, message });
  })
);

// GET /api/messages/:id/original — original message for reply form
router.get("/:id/original", requireAuth, (req, res) =>
  tryCatch(res, async () => {
    const original = await get(
      `SELECT m.*, u.name as sender_name FROM messages m LEFT JOIN users u ON m.sender_id=u.id WHERE m.id=?`,
      [req.params.id]
    );
    if (!original) return res.status(404).json({ success: false, message: "Message not found." });
    res.json({ success: true, original });
  })
);

// POST /api/messages/:id/reply
router.post("/:id/reply", requireAuth, (req, res) =>
  tryCatch(res, async () => {
    const original = await get(`SELECT * FROM messages WHERE id=?`, [req.params.id]);
    if (!original) return res.status(404).json({ success: false, message: "Message not found." });
    await run(
      `INSERT INTO messages (sender_id, recipient_id, subject, content, replied_to) VALUES (?,?,?, ?,?)`,
      [req.user.id, original.sender_id, `Re: ${original.subject}`, req.body.content, original.id]
    );
    res.json({ success: true, message: "✅ Reply sent!" });
  })
);

// ---------- Admin mailbox ----------

// GET /api/messages/admin/list
router.get("/admin/list", requireAdmin, (req, res) =>
  tryCatch(res, async () => {
    const messages = await all(
      `SELECT m.*, u.name as sender_name FROM messages m LEFT JOIN users u ON m.sender_id=u.id WHERE m.recipient_id IS NULL OR m.is_admin_message=1 ORDER BY m.created_at DESC`
    );
    const unreadRow = await get(`SELECT COUNT(*) as c FROM messages WHERE recipient_id IS NULL AND is_read=0`);
    res.json({ success: true, messages, unread: unreadRow.c });
  })
);

// POST /api/messages/admin/reply/:id
router.post("/admin/reply/:id", requireAdmin, (req, res) =>
  tryCatch(res, async () => {
    const original = await get(`SELECT * FROM messages WHERE id=?`, [req.params.id]);
    if (!original) return res.status(404).json({ success: false, message: "Message not found." });
    await run(
      `INSERT INTO messages (sender_id, recipient_id, subject, content, replied_to, is_admin_message) VALUES (?,?,?, ?,?,1)`,
      [req.user.id, original.sender_id, `Re: ${original.subject}`, req.body.content, original.id]
    );
    // Mark original admin-bound message as read
    if (original.recipient_id === null) await run("UPDATE messages SET is_read=1 WHERE id=?", [original.id]);
    res.json({ success: true, message: "✅ Reply sent to user!" });
  })
);

export default router;
