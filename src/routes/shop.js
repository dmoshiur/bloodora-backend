// ==================== BloodOra Backend API - Shop (Products / Cart / Orders) ====================
// Mounted once at /api/shop — paths below are relative to that.
import express from "express";
import { get, all, run } from "../db.js";
import { requireAuth } from "../auth.js";
import { tryCatch } from "../utils.js";

const router = express.Router();

// Resolve a cart map { productId: qty } into priced items (server is source of truth)
export async function getCartDetails(cart) {
  if (!cart || typeof cart !== "object") return { items: [], subtotal: 0, total: 0, count: 0 };
  const items = [];
  let subtotal = 0;
  for (const [pid, qty] of Object.entries(cart)) {
    const product = await get("SELECT * FROM products WHERE id=? AND is_available=1", [pid]);
    if (product) {
      const quantity = Math.max(1, parseInt(qty) || 1);
      const itemSubtotal = product.price * quantity;
      subtotal += itemSubtotal;
      items.push({ product, quantity, subtotal: itemSubtotal });
    }
  }
  return { items, subtotal, total: subtotal, count: Object.keys(cart).length };
}

// ---------- Products ----------

// GET /api/shop/products?category=&search=
router.get("/products", (req, res) =>
  tryCatch(res, async () => {
    const { category, search } = req.query;
    let sql = "SELECT * FROM products WHERE is_available=1";
    const params = [];
    if (category) { sql += " AND category=?"; params.push(category); }
    if (search) { sql += " AND name LIKE ?"; params.push(`%${search}%`); }
    sql += " ORDER BY created_at DESC";
    const products = await all(sql, params);
    const cats = await all("SELECT DISTINCT category FROM products WHERE category IS NOT NULL");
    const categories = cats.map((c) => c.category).filter(Boolean);
    res.json({ success: true, products, categories });
  })
);

// GET /api/shop/categories
router.get("/categories", (req, res) =>
  tryCatch(res, async () => {
    const cats = await all("SELECT DISTINCT category FROM products WHERE category IS NOT NULL");
    res.json({ success: true, categories: cats.map((c) => c.category).filter(Boolean) });
  })
);

// GET /api/shop/products/:id
router.get("/products/:id", (req, res) =>
  tryCatch(res, async () => {
    const product = await get("SELECT * FROM products WHERE id=?", [req.params.id]);
    if (!product) return res.status(404).json({ success: false, message: "Product not found." });
    res.json({ success: true, product });
  })
);

// ---------- Cart ----------

// POST /api/shop/cart/validate-item — frontend checks before adding to cart
router.post("/cart/validate-item", (req, res) =>
  tryCatch(res, async () => {
    const { product_id } = req.body || {};
    const product = await get("SELECT * FROM products WHERE id=? AND is_available=1", [product_id]);
    if (!product) return res.status(404).json({ success: false, message: "❌ Product not found." });
    if (product.stock <= 0) return res.status(400).json({ success: false, message: "⚠️ Out of stock." });
    res.json({ success: true, product, message: `${product.name} is available.` });
  })
);

// POST /api/shop/cart/resolve — price a cart map { "3": 2, "7": 1 }
router.post("/cart/resolve", (req, res) =>
  tryCatch(res, async () => {
    const cart = (req.body && req.body.cart) || {};
    const details = await getCartDetails(cart);
    res.json({ success: true, ...details });
  })
);

// ---------- Checkout ----------

// GET /api/shop/checkout/context — gateway numbers + user payment info + address
router.get("/checkout/context", requireAuth, (req, res) =>
  tryCatch(res, async () => {
    const settings = await get("SELECT * FROM site_settings LIMIT 1");
    const gateway_numbers = {
      bkash: settings?.bkash_merchant_number || "01709202140",
      nagad: settings?.nagad_merchant_number || "01800000000",
      upay: settings?.upay_merchant_number || "01600000000",
      rocket: settings?.rocket_merchant_number || "01900000000",
      pathao: settings?.pathao_merchant_number || "01500000000",
    };
    const u = req.user;
    res.json({
      success: true,
      gateway_numbers,
      user_payment_methods: {
        bkash: u.bkash_number, nagad: u.nagad_number, upay: u.upay_number,
        rocket: u.rocket_number, pathao: u.pathao_number,
        card_last_four: u.card_last_four, card_type: u.card_type,
      },
      user_address: {
        division: u.division || "", district: u.district || "", upazila: u.upazila || "", address: u.address_holding || "",
      },
    });
  })
);

// ---------- Orders ----------

// GET /api/shop/orders/mine
router.get("/orders/mine", requireAuth, (req, res) =>
  tryCatch(res, async () => {
    const orders = await all("SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC", [req.user.id]);
    res.json({ success: true, orders });
  })
);

// GET /api/shop/orders/:id — order + items (+ owner user for display)
router.get("/orders/:id", requireAuth, (req, res) =>
  tryCatch(res, async () => {
    const order = await get("SELECT * FROM orders WHERE id=?", [req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: "Order not found." });
    if (order.user_id && order.user_id !== req.user.id && !req.user.is_admin) {
      return res.status(403).json({ success: false, message: "❌ Unauthorized." });
    }
    const items = await all("SELECT * FROM order_items WHERE order_id=?", [order.id]);
    let orderUser = null;
    if (order.user_id) orderUser = await get("SELECT * FROM users WHERE id=?", [order.user_id]);
    res.json({ success: true, order, items, orderUser });
  })
);

// POST /api/shop/orders — checkout (body: cart + payment + delivery fields)
router.post("/orders", requireAuth, (req, res) =>
  tryCatch(res, async () => {
    const cart = (req.body && req.body.cart) || {};
    if (!cart || Object.keys(cart).length === 0) {
      return res.status(400).json({ success: false, type: "warning", message: "⚠️ Your cart is empty!" });
    }
    const { items, subtotal } = await getCartDetails(cart);
    if (items.length === 0) {
      return res.status(400).json({ success: false, type: "warning", message: "⚠️ Your cart is empty!" });
    }

    const {
      payment_method, delivery_address, division, district, upazila, transaction_id,
      bkash_number, nagad_number, upay_number, rocket_number, pathao_number, card_type, card_number,
    } = req.body;

    // Delivery validation: only Kalai allowed (case-insensitive, supports Bengali)
    const upazilaNorm = (upazila || "").toLowerCase().trim();
    let delivery_charge = 0;
    if (upazilaNorm.includes("kalai") || upazilaNorm.includes("কলাই")) {
      delivery_charge = 10;
    } else {
      return res.status(400).json({ success: false, message: "❌ Sorry! Home delivery is currently ONLY available in Kalai Upazila." });
    }

    const total = subtotal + delivery_charge;

    // Save payment method to user
    const pm = String(payment_method || "").toLowerCase();
    if (pm === "bkash") await run("UPDATE users SET bkash_number=? WHERE id=?", [bkash_number, req.user.id]);
    else if (pm === "nagad") await run("UPDATE users SET nagad_number=? WHERE id=?", [nagad_number, req.user.id]);
    else if (pm === "upay") await run("UPDATE users SET upay_number=? WHERE id=?", [upay_number, req.user.id]);
    else if (pm === "rocket") await run("UPDATE users SET rocket_number=? WHERE id=?", [rocket_number, req.user.id]);
    else if (pm === "pathao") await run("UPDATE users SET pathao_number=? WHERE id=?", [pathao_number, req.user.id]);
    else if (pm === "card") {
      const last4 = card_number ? String(card_number).slice(-4) : null;
      await run("UPDATE users SET card_type=?, card_last_four=? WHERE id=?", [card_type, last4, req.user.id]);
    }

    // Create order
    const now = new Date().toISOString();
    await run(
      `INSERT INTO orders (user_id, subtotal_amount, delivery_charge, total_amount, payment_method, payment_status, transaction_id, delivery_address, delivery_division, delivery_district, delivery_upazila, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [req.user.id, subtotal, delivery_charge, total, payment_method, "pending", transaction_id, delivery_address, division, district, upazila, "pending", now, now]
    );

    const orderRow = await get("SELECT last_insert_rowid() as id");
    let orderId = orderRow?.id;
    if (!orderId) {
      const m = await get("SELECT id FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 1", [req.user.id]);
      orderId = m?.id;
    }

    for (const item of items) {
      await run(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, price) VALUES (?,?,?,?,?)`,
        [orderId, item.product.id, item.product.name, item.quantity, item.product.price]
      );
      await run(`UPDATE products SET stock = stock - ? WHERE id=? AND stock >= ?`, [item.quantity, item.product.id, item.quantity]);
    }

    res.json({ success: true, orderId, message: "✅ Order placed successfully! Admin will confirm your payment." });
  })
);

export default router;
