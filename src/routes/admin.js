// ==================== BloodOra Backend API - Admin ====================
import express from "express";
import bcrypt from "bcryptjs";
import { get, all, run } from "../db.js";
import { requireAdmin, requireSuperAdmin, signToken, genSessionToken } from "../auth.js";
import { upload } from "../upload.js";
import { getClientIp, getDeviceFingerprint, normalizeUser, tryCatch } from "../utils.js";

const router = express.Router();

// GET /api/admin/dashboard
router.get("/dashboard", requireAdmin, (req, res) =>
  tryCatch(res, async () => {
    const users = await all("SELECT * FROM users ORDER BY datetime(created_at) DESC");
    const total_users = (await get("SELECT COUNT(*) as c FROM users"))?.c || 0;
    const total_donors = (await get("SELECT COUNT(*) as c FROM users WHERE can_donate=1 AND is_verified=1"))?.c || 0;
    const admins = (await get("SELECT COUNT(*) as c FROM users WHERE is_admin=1"))?.c || 0;
    const unread_messages = (await get("SELECT COUNT(*) as c FROM messages WHERE recipient_id IS NULL AND is_read=0"))?.c || 0;
    const pending_verifications = (await get("SELECT COUNT(*) as c FROM users WHERE is_verified=0 AND age>=18"))?.c || 0;
    const urgent_requests = (await get("SELECT COUNT(*) as c FROM blood_requests WHERE is_urgent=1 AND is_fulfilled=0"))?.c || 0;
    const total_products = (await get("SELECT COUNT(*) as c FROM products"))?.c || 0;
    const total_orders = (await get("SELECT COUNT(*) as c FROM orders"))?.c || 0;
    const pending_orders = (await get("SELECT COUNT(*) as c FROM orders WHERE status='pending'"))?.c || 0;
    const stats = { total_users, total_donors, admins, unread_messages, pending_verifications, urgent_requests, total_products, total_orders, pending_orders };
    const notice = await get("SELECT * FROM site_notice LIMIT 1");
    const settings = await get("SELECT * FROM site_settings LIMIT 1");
    res.json({ success: true, all_users: users.map((u) => normalizeUser(u)), stats, current_notice: notice?.content || "", settings: settings || null });
  })
);

// ---------- Site Settings ----------

// GET /api/admin/settings
router.get("/settings", requireAdmin, (req, res) =>
  tryCatch(res, async () => {
    const settings = (await get("SELECT * FROM site_settings LIMIT 1")) || {};
    res.json({ success: true, settings });
  })
);

// POST /api/admin/settings
router.post("/settings", requireAdmin, (req, res) =>
  tryCatch(res, async () => {
    let s = await get("SELECT * FROM site_settings LIMIT 1");
    if (!s) {
      await run(`INSERT INTO site_settings (site_name) VALUES (?)`, ["BloodOra"]);
      s = await get("SELECT * FROM site_settings LIMIT 1");
    }
    await run(
      `UPDATE site_settings SET site_name=?, site_email=?, site_phone=?, site_address=?, site_description=?, facebook_url=?, twitter_url=?, instagram_url=?, linkedin_url=?, bkash_merchant_number=?, nagad_merchant_number=?, upay_merchant_number=?, rocket_merchant_number=?, pathao_merchant_number=?, updated_at=? WHERE id=?`,
      [
        req.body.site_name || s.site_name, req.body.site_email || s.site_email,
        req.body.site_phone || s.site_phone, req.body.site_address || s.site_address,
        req.body.site_description || s.site_description, req.body.facebook_url || s.facebook_url,
        req.body.twitter_url || s.twitter_url, req.body.instagram_url || s.instagram_url,
        req.body.linkedin_url || s.linkedin_url, req.body.bkash_merchant_number || s.bkash_merchant_number,
        req.body.nagad_merchant_number || s.nagad_merchant_number, req.body.upay_merchant_number || s.upay_merchant_number,
        req.body.rocket_merchant_number || s.rocket_merchant_number, req.body.pathao_merchant_number || s.pathao_merchant_number,
        new Date().toISOString(), s.id,
      ]
    );
    res.json({ success: true, message: "✅ Site settings updated successfully!" });
  })
);

// ---------- Site Notice ----------

router.post("/notice", requireAdmin, (req, res) =>
  tryCatch(res, async () => {
    const content = (req.body.notice_content || "").trim();
    if (!content) return res.status(400).json({ success: false, type: "warning", message: "⚠️ Notice cannot be empty." });
    const notice = await get("SELECT * FROM site_notice LIMIT 1");
    if (!notice) await run("INSERT INTO site_notice (content, active) VALUES (?,1)", [content]);
    else await run("UPDATE site_notice SET content=?, active=1, updated_at=? WHERE id=?", [content, new Date().toISOString(), notice.id]);
    res.json({ success: true, message: "✅ Site notice updated." });
  })
);

router.get("/notice/clear", requireAdmin, (req, res) =>
  tryCatch(res, async () => {
    await run("DELETE FROM site_notice");
    res.json({ success: true, type: "info", message: "ℹ️ Notice cleared." });
  })
);

// ---------- Donor verification / roles ----------

router.post("/verify-donor/:id", requireAdmin, (req, res) =>
  tryCatch(res, async () => {
    const user = await get("SELECT * FROM users WHERE id=?", [req.params.id]);
    if (user && user.age >= 18) {
      await run("UPDATE users SET is_verified=1 WHERE id=?", [req.params.id]);
      return res.json({ success: true, message: `✅ ${user.name} is now a verified donor!` });
    }
    res.status(400).json({ success: false, type: "warning", message: "⚠️ User must be 18+ to be verified." });
  })
);

router.post("/promote/:id", requireSuperAdmin, (req, res) =>
  tryCatch(res, async () => {
    await run("UPDATE users SET is_admin=1 WHERE id=?", [req.params.id]);
    const u = await get("SELECT name FROM users WHERE id=?", [req.params.id]);
    res.json({ success: true, message: `✅ ${u?.name} is now an Admin.` });
  })
);

router.post("/demote/:id", requireSuperAdmin, (req, res) =>
  tryCatch(res, async () => {
    const u = await get("SELECT * FROM users WHERE id=?", [req.params.id]);
    if (u?.is_super_admin) return res.status(400).json({ success: false, type: "warning", message: "⚠️ Cannot demote Super Admin." });
    await run("UPDATE users SET is_admin=0 WHERE id=?", [req.params.id]);
    res.json({ success: true, type: "info", message: `ℹ️ Admin rights removed from ${u?.name}.` });
  })
);

router.delete("/user/:id", requireSuperAdmin, (req, res) =>
  tryCatch(res, async () => {
    const u = await get("SELECT * FROM users WHERE id=?", [req.params.id]);
    if (!u) return res.status(404).json({ success: false, message: "User not found." });
    if (u.is_super_admin) return res.status(400).json({ success: false, type: "warning", message: "⚠️ Cannot delete Super Admin." });
    if (u.id === req.user.id) return res.status(400).json({ success: false, type: "warning", message: "⚠️ Cannot delete your own account." });
    await run("DELETE FROM users WHERE id=?", [req.params.id]);
    res.json({ success: true, message: `✅ User '${u.name}' deleted.` });
  })
);

// ---------- Super-admin user edit ----------

router.post("/user/update/:id", requireSuperAdmin, (req, res) =>
  tryCatch(res, async () => {
    const user = await get("SELECT * FROM users WHERE id=?", [req.params.id]);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    if (user.is_super_admin || user.id === req.user.id) {
      return res.status(400).json({ success: false, type: "warning", message: "⚠️ Cannot edit this user." });
    }
    const is_verified = req.body.is_verified ? 1 : 0;
    const is_admin = req.body.is_admin ? 1 : 0;
    const can_donate = req.body.can_donate ? 1 : 0;
    await run(
      `UPDATE users SET name=?, email=?, phone=?, blood_group=?, district=?, upazila=?, address_holding=?, is_verified=?, is_admin=?, can_donate=? WHERE id=?`,
      [req.body.name, req.body.email, req.body.phone, req.body.blood_group, req.body.district, req.body.upazila, req.body.address_holding, is_verified, is_admin, can_donate, req.params.id]
    );
    if (req.body.new_password && req.body.new_password.length >= 6) {
      const hash = await bcrypt.hash(req.body.new_password, 10);
      await run("UPDATE users SET password_hash=?, session_token=? WHERE id=?", [hash, genSessionToken(), req.params.id]);
      return res.json({ success: true, type: "info", message: "🔑 Password changed. User will need to login again." });
    }
    res.json({ success: true, message: `✅ User '${req.body.name}' updated!` });
  })
);

router.get("/user/details/:id", requireSuperAdmin, (req, res) =>
  tryCatch(res, async () => {
    const u = await get("SELECT * FROM users WHERE id=?", [req.params.id]);
    if (!u) return res.status(404).json({ success: false, message: "Not found." });
    res.json({
      success: true,
      user: {
        id: u.id, name: u.name, email: u.email, phone: u.phone, blood_group: u.blood_group,
        district: u.district, upazila: u.upazila, address_holding: u.address_holding,
        is_verified: !!u.is_verified, is_admin: !!u.is_admin, can_donate: !!u.can_donate,
        last_login_ip: u.last_login_ip, last_login_device: u.last_login_device,
        last_login_at: u.last_login_at ? new Date(u.last_login_at).toISOString().slice(0, 16).replace("T", " ") : null,
        created_at: u.created_at ? new Date(u.created_at).toISOString().slice(0, 10) : null,
      },
    });
  })
);

router.post("/create-admin", requireSuperAdmin, (req, res) =>
  tryCatch(res, async () => {
    if (!req.body.email || !req.body.password || !req.body.name) {
      return res.status(400).json({ success: false, message: "❌ Name, email and password are required." });
    }
    if (await get("SELECT id FROM users WHERE email=?", [req.body.email])) {
      return res.status(409).json({ success: false, type: "warning", message: "⚠️ Email already registered." });
    }
    const hash = await bcrypt.hash(req.body.password, 10);
    await run(
      `INSERT INTO users (name,email,phone,password_hash,is_admin,is_verified,is_super_admin,blood_group,district,upazila,age,can_donate,session_token,last_login_ip,last_login_device,last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.body.name, req.body.email, req.body.phone, hash, 1, 1, 0, "O+", "Joypurhat", "Kalai", 25, 1, genSessionToken(), getClientIp(req), getDeviceFingerprint(req), new Date().toISOString()]
    );
    res.json({ success: true, message: `✅ New admin '${req.body.name}' created!` });
  })
);

// ---------- Impersonation ----------

// POST /api/admin/impersonate/:id — super admin becomes another user.
// Returns a NEW token for the target user. The frontend keeps its own admin token stored to switch back.
router.post("/impersonate/:id", requireSuperAdmin, (req, res) =>
  tryCatch(res, async () => {
    const user = await get("SELECT * FROM users WHERE id=?", [req.params.id]);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    if (user.is_super_admin || user.id === req.user.id) {
      return res.status(400).json({ success: false, type: "warning", message: "⚠️ Cannot impersonate." });
    }
    const newToken = genSessionToken();
    await run("UPDATE users SET session_token=? WHERE id=?", [newToken, user.id]);
    user.session_token = newToken;
    const { password_hash, ...safeUser } = normalizeUser(user);
    res.json({
      success: true,
      token: signToken(user),
      user: safeUser,
      message: `🎭 Now logged in as ${user.name}. Go to profile to switch back.`,
    });
  })
);

// POST /api/admin/switch-back — called with the SUPER ADMIN's own token; revokes impersonated user's session.
router.post("/switch-back", requireSuperAdmin, (req, res) =>
  tryCatch(res, async () => {
    const { impersonated_user_id } = req.body || {};
    if (impersonated_user_id) {
      await run("UPDATE users SET session_token=? WHERE id=?", [genSessionToken(), impersonated_user_id]);
    }
    res.json({ success: true, message: "🔙 Switched back to admin account." });
  })
);

// ---------- Products (shop admin) ----------

router.get("/products", requireAdmin, (req, res) =>
  tryCatch(res, async () => {
    const products = await all("SELECT * FROM products ORDER BY created_at DESC");
    res.json({ success: true, products });
  })
);

router.post("/products", requireAdmin, upload.single("image"), (req, res) =>
  tryCatch(res, async () => {
    const { name, description, price, category, stock } = req.body;
    if (!name || price === undefined || price === "") {
      return res.status(400).json({ success: false, message: "❌ Product name and price are required." });
    }
    let filename = "default_product.jpg";
    if (req.file) filename = req.file.filename;
    await run(
      `INSERT INTO products (name, description, price, category, stock, image_file, is_available) VALUES (?,?,?,?,?,?,1)`,
      [name, description, parseFloat(price), category, parseInt(stock || 0), filename]
    );
    res.json({ success: true, message: `✅ Product '${name}' added!` });
  })
);

router.put("/products/:id", requireAdmin, upload.single("image"), (req, res) =>
  tryCatch(res, async () => {
    const product = await get("SELECT * FROM products WHERE id=?", [req.params.id]);
    if (!product) return res.status(404).json({ success: false, message: "Product not found." });
    const { name, description, price, category, stock, is_available } = req.body;
    let filename = product.image_file;
    if (req.file) filename = req.file.filename;
    const avail = is_available ? 1 : 0;
    await run(
      `UPDATE products SET name=?, description=?, price=?, category=?, stock=?, image_file=?, is_available=? WHERE id=?`,
      [name, description, parseFloat(price), category, parseInt(stock || 0), filename, avail, req.params.id]
    );
    res.json({ success: true, message: `✅ Product '${name}' updated!` });
  })
);

router.delete("/products/:id", requireAdmin, (req, res) =>
  tryCatch(res, async () => {
    const product = await get("SELECT * FROM products WHERE id=?", [req.params.id]);
    if (product) {
      await run("DELETE FROM products WHERE id=?", [req.params.id]);
      return res.json({ success: true, message: `✅ Product '${product.name}' deleted.` });
    }
    res.status(404).json({ success: false, message: "Product not found." });
  })
);

// ---------- Orders (shop admin) ----------

router.get("/orders", requireAdmin, (req, res) =>
  tryCatch(res, async () => {
    const { status } = req.query;
    let sql = "SELECT o.*, u.name as user_name FROM orders o LEFT JOIN users u ON o.user_id=u.id";
    const params = [];
    if (status) { sql += " WHERE o.status=?"; params.push(status); }
    sql += " ORDER BY o.created_at DESC";
    const orders = await all(sql, params);
    res.json({ success: true, orders });
  })
);

router.get("/orders/:id", requireAdmin, (req, res) =>
  tryCatch(res, async () => {
    const order = await get(
      "SELECT o.*, u.name as user_name, u.phone as user_phone, u.email as user_email FROM orders o LEFT JOIN users u ON o.user_id=u.id WHERE o.id=?",
      [req.params.id]
    );
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    const items = await all(
      "SELECT oi.*, p.image_file FROM order_items oi LEFT JOIN products p ON oi.product_id=p.id WHERE oi.order_id=?",
      [req.params.id]
    );
    res.json({ success: true, order, items });
  })
);

router.post("/orders/:id/confirm-payment", requireAdmin, (req, res) =>
  tryCatch(res, async () => {
    await run("UPDATE orders SET payment_status='confirmed', status='processing', updated_at=? WHERE id=?", [new Date().toISOString(), req.params.id]);
    res.json({ success: true, message: "✅ Payment confirmed! Order is now processing." });
  })
);

router.post("/orders/:id/status", requireAdmin, (req, res) =>
  tryCatch(res, async () => {
    const { status } = req.body;
    await run("UPDATE orders SET status=?, updated_at=? WHERE id=?", [status, new Date().toISOString(), req.params.id]);
    res.json({ success: true, message: `✅ Order status updated to ${status}.` });
  })
);

// ---------- Backup ----------

router.get("/backup", requireSuperAdmin, (req, res) => {
  // On Turso (recommended production setup) backups are managed in the Turso dashboard.
  res.json({
    success: true,
    type: "info",
    message: "📥 This deployment uses the Turso serverless database — create backups from the Turso dashboard (turso.tech).",
  });
});

export default router;
