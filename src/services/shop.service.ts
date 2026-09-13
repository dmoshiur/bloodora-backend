import { productRepo } from "../repos/product.repo.js";
import { orderRepo } from "../repos/order.repo.js";
import { userRepo } from "../repos/user.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { reviewRepo } from "../repos/review.repo.js";
import { smtpService } from "./smtp.service.js";
import { loadSettings } from "./meta.service.js";
import { CATEGORIES } from "../data/constants.js";
import { ApiError, randomId } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { Order, OrderItem, OrderRow, ProductRow, SafeUser } from "../types.js";

/** Kalai-only delivery, ৳10 flat (original business rule). */
const DELIVERY_FEE = 10;
const DELIVERY_UPAZILAS = ["kalai", "কলাই"];

// ---------- shape mappers (original frontend contract field names) ----------

export function shapeProduct(row: ProductRow) {
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    stock: row.stock,
    category: row.category,
    description: row.description,
    image_file: row.image_file,
    is_available: row.is_active === 1 ? 1 : 0,
    sales_count: row.sales_count,
    created_at: row.created_at,
  };
}

export function shapeItem(it: OrderItem) {
  return {
    id: it.id,
    order_id: it.order_id,
    product_id: it.product_id,
    product_name: it.product_name,
    image_file: it.product_image,
    price: it.price,
    quantity: it.qty,
    line_total: it.line_total,
  };
}

export async function shapeOrder(row: OrderRow) {
  const user = row.user_id ? await userRepo.findById(row.user_id) : null;
  return {
    id: row.id,
    user_id: row.user_id,
    user_name: user?.name ?? row.customer_name,
    user_phone: user?.phone ?? row.customer_phone,
    user_email: user?.email ?? null,
    guest_name: null,
    guest_phone: null,
    guest_email: null,
    subtotal_amount: row.subtotal,
    delivery_charge: row.delivery_fee,
    total_amount: row.total,
    payment_method: row.payment_method,
    payment_status: row.payment_status,
    transaction_id: row.payment_ref,
    delivery_address: row.address,
    delivery_division: row.division,
    delivery_district: row.district,
    delivery_upazila: row.upazila,
    status: row.status,
    note: row.note,
    created_at: row.created_at,
  };
}

async function orderWithItems(row: OrderRow): Promise<Order & { items: OrderItem[] }> {
  const items = (await orderRepo.items(row.id)) as OrderItem[];
  return { ...row, customer: null, items };
}

// ---------- service ----------

export const shopService = {
  /** GET /api/shop/products?category=&search= */
  async productsList(opts: { category?: string; search?: string } = {}) {
    const rows = await productRepo.list({ category: opts.category, search: opts.search, limit: 200 });
    return {
      success: true,
      products: rows.map(shapeProduct),
      categories: CATEGORIES,
    };
  },

  /** GET /api/shop/products/:id */
  async productDetail(id: string) {
    const row = await productRepo.findById(id);
    if (!row) throw ApiError.notFound("Product not found", "PRODUCT_NOT_FOUND");
    const [reviews, avg] = await Promise.all([reviewRepo.byProduct(id), reviewRepo.avgRating(id)]);
    return {
      success: true,
      product: {
        ...shapeProduct(row),
        rating: avg,
        reviews: reviews.map((r) => ({
          id: r.id,
          rating: r.rating,
          title: r.title,
          body: r.body,
          created_at: r.created_at,
        })),
      },
    };
  },

  /** POST /api/shop/cart/validate-item — {product_id}. */
  async validateItem(productId: string): Promise<{ ok: true }> {
    const row = await productRepo.findById(productId);
    if (!row) throw ApiError.badRequest("Product not found.", "PRODUCT_NOT_FOUND");
    if (row.is_active !== 1) throw ApiError.badRequest("This product is no longer available.", "UNAVAILABLE");
    if (row.stock < 1) throw ApiError.badRequest("This product is out of stock.", "OUT_OF_STOCK");
    return { ok: true as const };
  },

  /**
   * POST /api/shop/cart/resolve — price a cart map {"<id>": qty}.
   * Original shape: items: [{product, quantity, subtotal}].
   */
  async resolveCart(cart: Record<string, unknown> = {}): Promise<{ items: { product: ReturnType<typeof shapeProduct>; quantity: number; subtotal: number }[]; subtotal: number; total: number; count: number }> {
    const items: { product: ReturnType<typeof shapeProduct>; quantity: number; subtotal: number }[] = [];
    let subtotal = 0;
    for (const [pid, qty] of Object.entries(cart)) {
      const row = await productRepo.findById(pid);
      if (!row || row.is_active !== 1) continue;
      const quantity = Math.max(1, parseInt(String(qty), 10) || 1);
      const itemSubtotal = row.price * quantity;
      subtotal += itemSubtotal;
      items.push({ product: shapeProduct(row), quantity, subtotal: itemSubtotal });
    }
    subtotal = Math.round(subtotal * 100) / 100;
    return { items, subtotal, total: subtotal, count: Object.keys(cart).length };
  },

  /** GET /api/shop/checkout/context */
  async checkoutContext(user: SafeUser) {
    const s = await loadSettings();
    return {
      success: true,
      gateway_numbers: {
        bkash: s.bkash_merchant_number || "01709202140",
        nagad: s.nagad_merchant_number || "01800000000",
        upay: s.upay_merchant_number || "01600000000",
        rocket: s.rocket_merchant_number || "01900000000",
        pathao: s.pathao_merchant_number || "01500000000",
      },
      user_payment_methods: {
        bkash: user.bkash_number,
        nagad: user.nagad_number,
        upay: user.upay_number,
        rocket: user.rocket_number,
        pathao: user.pathao_number,
        card_last_four: user.card_last_four,
        card_type: user.card_type,
      },
      user_address: {
        division: user.division || "",
        district: user.district || "",
        upazila: user.upazila || "",
        address: user.address_holding || "",
      },
    };
  },

  /**
   * POST /api/shop/orders — checkout. Original payload:
   * {cart: {id: qty}, payment_method, delivery_address, division, district, upazila,
   *  transaction_id, bkash_number, nagad_number, upay_number, rocket_number,
   *  pathao_number, card_type, card_number}
   */
  async placeOrder(user: SafeUser, body: Record<string, unknown>): Promise<{ orderId: string; message: string }> {
    const cart = (body.cart && typeof body.cart === "object" ? body.cart : {}) as Record<string, unknown>;
    if (!Object.keys(cart).length) throw ApiError.badRequest("⚠️ Your cart is empty!", "EMPTY_CART");

    const { items, subtotal } = await this.resolveCart(cart);
    if (!items.length) throw ApiError.badRequest("⚠️ Your cart is empty!", "EMPTY_CART");

    const str = (k: string) => (body[k] == null ? "" : String(body[k])).trim();
    const upazilaNorm = str("upazila").toLowerCase();
    const deliveryOk = DELIVERY_UPAZILAS.some((u) => upazilaNorm.includes(u));
    if (!deliveryOk) {
      throw ApiError.badRequest("❌ Sorry! Home delivery is currently ONLY available in Kalai Upazila.", "DELIVERY_AREA_NOT_SERVED");
    }
    const deliveryFee = DELIVERY_FEE;
    const total = Math.round((subtotal + deliveryFee) * 100) / 100;

    // Persist the chosen payment method on the user's wallet.
    const pm = str("payment_method").toLowerCase();
    if (pm === "bkash") await userRepo.setWallet(user.id, { bkash_number: str("bkash_number") || null });
    else if (pm === "nagad") await userRepo.setWallet(user.id, { nagad_number: str("nagad_number") || null });
    else if (pm === "upay") await userRepo.setWallet(user.id, { upay_number: str("upay_number") || null });
    else if (pm === "rocket") await userRepo.setWallet(user.id, { rocket_number: str("rocket_number") || null });
    else if (pm === "pathao") await userRepo.setWallet(user.id, { pathao_number: str("pathao_number") || null });
    else if (pm === "card") {
      const cardNumber = str("card_number");
      await userRepo.setWallet(user.id, {
        card_type: str("card_type") || null,
        card_last_four: cardNumber ? cardNumber.slice(-4) : null,
      });
    }

    const orderId = randomId();
    const orderItems = items.map((it) => ({
      id: randomId(),
      order_id: orderId,
      product_id: it.product.id,
      product_name: it.product.name,
      product_image: it.product.image_file,
      price: it.product.price,
      qty: it.quantity,
      line_total: Math.round(it.subtotal * 100) / 100,
    }));

    try {
      await orderRepo.placeTx(
        {
          id: orderId,
          user_id: user.id,
          customer_name: user.name,
          customer_phone: user.phone,
          address: str("delivery_address") || `${user.upazila || ""}, ${user.district || ""}, ${user.division || ""}`.trim(),
          city: user.city || "Kalai",
          division: str("division") || user.division || null,
          district: str("district") || user.district || null,
          upazila: str("upazila") || user.upazila || null,
          payment_method: pm || "cash",
          payment_ref: str("transaction_id") || null,
          subtotal,
          delivery_fee: deliveryFee,
          total,
          status: "pending",
          payment_status: "pending",
          note: str("note") || null,
        },
        orderItems,
      );
    } catch (err) {
      throw err;
    }

    const initials = user.name.split(/\s+/).map((w) => w[0]?.toUpperCase() || "").slice(0, 2).join("");
    await activityRepo.create("order", user.id, `New shop order #${orderId}`, {
      detail: `${initials} • ${str("upazila") || user.upazila || "Kalai"} • ৳${total.toFixed(0)}`,
      link: "/shop/my-orders",
    });
    smtpService.sendOrderConfirmation(orderId).catch((e) => logger.warn("order: confirmation email failed", { err: String(e) }));
    logger.info("order: placed", { order: orderId, total, user: user.id });

    return { orderId, message: "✅ Order placed successfully! Admin will confirm your payment." };
  },

  /** GET /api/shop/orders/mine */
  async myOrders(user: SafeUser) {
    const rows = await orderRepo.byUser(user.id);
    const orders = await Promise.all(rows.map(shapeOrder));
    return { success: true, orders };
  },

  /** GET /api/shop/orders/:id — owner or admin. */
  async orderDetail(user: SafeUser, orderId: string) {
    const row = await orderRepo.findById(orderId);
    if (!row) throw ApiError.notFound("Order not found.", "ORDER_NOT_FOUND");
    if (row.user_id !== user.id && !user.is_admin) throw ApiError.forbidden("❌ Unauthorized.", "FORBIDDEN");
    const [order, items, orderUser] = await Promise.all([
      shapeOrder(row),
      orderRepo.items(orderId),
      row.user_id ? userRepo.findById(row.user_id) : Promise.resolve(null),
    ]);
    const safeUser = orderUser
      ? {
          id: orderUser.id,
          name: orderUser.name,
          email: orderUser.email,
          phone: orderUser.phone,
          address_holding: orderUser.address_holding,
          division: orderUser.division,
          district: orderUser.district,
          upazila: orderUser.upazila,
        }
      : null;
    return { success: true, order, items: items.map(shapeItem), orderUser: safeUser };
  },

  // ---------- admin: products (multipart image) ----------

  async adminProducts() {
    const rows = await productRepo.all();
    return { success: true, products: rows.map(shapeProduct) };
  },

  async adminProductCreate(actor: SafeUser, fields: Record<string, unknown>, imageFile: string | null): Promise<string> {
    const str = (k: string) => (fields[k] == null ? "" : String(fields[k])).trim();
    const name = str("name");
    if (!name) throw ApiError.badRequest("Product name is required.", "NAME_REQUIRED");
    const price = Number(str("price"));
    if (!Number.isFinite(price) || price < 0) throw ApiError.badRequest("Price must be a positive number.", "BAD_PRICE");
    const stock = Math.max(0, Math.trunc(Number(str("stock")) || 0));
    const id = randomId();
    await productRepo.create({
      id,
      slug: `p-${id}`,
      name,
      price,
      stock,
      category: str("category") || null,
      description: str("description") || null,
      image_file: imageFile ?? null,
      is_active: 1,
      sales_count: 0,
    });
    await activityRepo.create("product", actor.id, `Product "${name}" added to the shop`);
    return "✅ Product added successfully!";
  },

  async adminProductUpdate(actor: SafeUser, id: string, fields: Record<string, unknown>, imageFile: string | null): Promise<string> {
    const existing = await productRepo.findById(id);
    if (!existing) throw ApiError.notFound("Product not found.", "PRODUCT_NOT_FOUND");
    const str = (k: string) => (fields[k] == null ? "" : String(fields[k])).trim();
    const updates: Parameters<typeof productRepo.update>[1] = {};
    if (str("name")) updates.name = str("name");
    if (str("description") !== "") updates.description = str("description") || null;
    if (str("category")) updates.category = str("category");
    const price = Number(str("price"));
    if (str("price") && Number.isFinite(price) && price >= 0) updates.price = price;
    if (str("stock")) updates.stock = Math.max(0, Math.trunc(Number(str("stock"))));
    if (str("is_available") !== "") updates.is_active = ["1", "true", "yes"].includes(str("is_available").toLowerCase()) ? 1 : 0;
    if (imageFile) updates.image_file = imageFile;
    if (Object.keys(updates).length) await productRepo.update(id, updates);
    await activityRepo.create("product", actor.id, `Product "${existing.name}" updated`);
    return "✅ Product updated successfully!";
  },

  async adminProductDelete(actor: SafeUser, id: string): Promise<string> {
    const existing = await productRepo.findById(id);
    if (!existing) throw ApiError.notFound("Product not found.", "PRODUCT_NOT_FOUND");
    await productRepo.delete(id);
    await activityRepo.create("product", actor.id, `Product "${existing.name}" deleted`);
    return "✅ Product deleted.";
  },

  // ---------- admin: orders ----------

  async adminOrders(status?: string) {
    const rows = await orderRepo.list({ status });
    const orders = await Promise.all(rows.map(async (r) => ({ ...(await shapeOrder(r)) })));
    return { success: true, orders };
  },

  async adminOrder(id: string) {
    const row = await orderRepo.findById(id);
    if (!row) throw ApiError.notFound("Order not found.", "ORDER_NOT_FOUND");
    const [order, items] = await Promise.all([shapeOrder(row), orderRepo.items(id)]);
    return { success: true, order, items: items.map(shapeItem) };
  },

  async adminConfirmPayment(actor: SafeUser, id: string): Promise<string> {
    const row = await orderRepo.findById(id);
    if (!row) throw ApiError.notFound("Order not found.", "ORDER_NOT_FOUND");
    if (row.payment_status === "confirmed") return "ℹ️ Payment already confirmed.";
    await orderRepo.setStatus(id, row.status, "confirmed");
    await activityRepo.create("order_payment", actor.id, `Payment confirmed for order ${id}`);
    return "✅ Payment confirmed!";
  },

  async adminOrderStatus(actor: SafeUser, id: string, status: string): Promise<string> {
    const valid = ["pending", "processing", "shipped", "delivered", "cancelled"];
    if (!valid.includes(status)) throw ApiError.badRequest(`Invalid status (expected one of: ${valid.join(", ")}).`, "BAD_STATUS");
    const row = await orderRepo.findById(id);
    if (!row) throw ApiError.notFound("Order not found.", "ORDER_NOT_FOUND");
    if (status === "cancelled" && row.status !== "cancelled") {
      const items = await orderRepo.items(id);
      for (const it of items) await productRepo.adjustStock(it.product_id, it.qty);
    }
    await orderRepo.setStatus(id, status, status === "cancelled" ? row.payment_status : undefined);
    await activityRepo.create("order_status", actor.id, `Order ${id} → ${status}`);
    return `✅ Order status updated to ${status}.`;
  },

  // legacy helpers (kept for the admin dashboard service)
  async withItems(orderId: string): Promise<Order> {
    const row = await orderRepo.findById(orderId);
    if (!row) throw ApiError.notFound("Order not found", "ORDER_NOT_FOUND");
    return orderWithItems(row);
  },
};
