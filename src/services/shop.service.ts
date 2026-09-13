import { productRepo } from "../repos/product.repo.js";
import { orderRepo, OutOfStockError } from "../repos/order.repo.js";
import { userRepo } from "../repos/user.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { reviewRepo } from "../repos/review.repo.js";
import { transactionRepo } from "../repos/transaction.repo.js";
import { auditRepo } from "../repos/audit.repo.js";
import { emailService } from "./email.service.js";
import { paymentService } from "./payment.service.js";
import { notificationService } from "./notification.service.js";
import { loadSettings } from "./meta.service.js";
import { translate } from "../i18n/index.js";
import { CATEGORIES } from "../data/constants.js";
import { ApiError, randomId } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { Order, OrderItem, OrderRow, ProductRow, SafeUser } from "../types.js";

/**
 * Delivery rules.
 *
 * The area list and the fee are read from `settings` (Admin → Site Settings),
 * with the original Kalai-only / ৳10 business rule as the fallback. They used to
 * be constants here, which meant an admin could change `delivery_fee` in the
 * panel and the checkout would keep charging ৳10 — the stored configuration was
 * silently ignored. The backend remains the only authority on price: the client
 * sends product ids and quantities, never an amount.
 */
const DEFAULT_DELIVERY_FEE = 10;
const DEFAULT_DELIVERY_UPAZILAS = ["kalai", "কলাই"];

async function deliveryRules(): Promise<{ fee: number; upazilas: string[]; freeAbove: number; areas: string[] }> {
  const s = await loadSettings();
  const fee = Number.isFinite(Number(s.delivery_fee)) && Number(s.delivery_fee) >= 0 ? Number(s.delivery_fee) : DEFAULT_DELIVERY_FEE;
  const freeAbove = Number.isFinite(Number(s.free_shipping_threshold)) ? Number(s.free_shipping_threshold) : 0;
  const areas = String(s.delivery_areas || "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  const upazilas = areas.length ? areas.map((a) => a.toLowerCase()) : DEFAULT_DELIVERY_UPAZILAS;
  return { fee, upazilas, freeAbove, areas: areas.length ? areas : ["Kalai"] };
}

/** Money is stored and compared in whole poisha to avoid float drift. */
function round2(n: number): number {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export interface PricedItem {
  product: ReturnType<typeof shapeProduct>;
  quantity: number;
  unit_price: number;
  subtotal: number;
}

export interface PricedCart {
  items: PricedItem[];
  /** Items that could not be honoured (lenient mode only). */
  skipped: { product_id: string; reason: string }[];
  subtotal: number;
  delivery_fee: number;
  total: number;
  count: number;
  currency: string;
  delivery: { areas: string[]; fee: number; free_shipping_threshold: number };
}

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

  /** GET /api/shop/categories — live categories (with product counts) for filter chips. */
  async categories() {
    const rows = await productRepo.categories();
    return {
      success: true,
      categories: rows.map((r) => r.category),
      details: rows,
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
  async resolveCart(cart: Record<string, unknown> = {}, lang?: string | null): Promise<PricedCart> {
    // Display pricing: unavailable items are reported in `skipped` rather than
    // silently dropped, so the cart page can explain why a line disappeared.
    return this.priceCart(cart, { strict: false, lang });
  },

  /**
   * Authoritative pricing — the ONLY place an order amount is computed.
   *
   * Prices come from the `products` table, never from the request. The client
   * supplies `{productId: qty}` and nothing else that affects money.
   *
   * `strict: true` (checkout) rejects anything that cannot be honoured:
   * an unknown or inactive product, or a quantity above available stock.
   * `strict: false` (cart page) keeps those items out of the total but reports
   * them in `skipped`, because a product deleted while it sat in a cart should
   * not make the whole page fail.
   */
  async priceCart(cart: Record<string, unknown> = {}, opts: { strict?: boolean; lang?: string | null } = {}): Promise<PricedCart> {
    const lang = opts.lang ?? null;
    const items: PricedItem[] = [];
    const skipped: { product_id: string; reason: string }[] = [];
    let subtotal = 0;

    const entries = Object.entries(cart ?? {});
    if (entries.length > 100) throw ApiError.badRequest("Too many cart lines (max 100).", "CART_TOO_LARGE");

    for (const [pid, qtyRaw] of entries) {
      const quantity = Math.max(1, Math.min(999, parseInt(String(qtyRaw), 10) || 1));
      const row = await productRepo.findById(pid);
      if (!row) {
        if (opts.strict) throw ApiError.badRequest(translate(lang, "order.unavailable", { product: pid }), "PRODUCT_NOT_FOUND");
        skipped.push({ product_id: pid, reason: "not_found" });
        continue;
      }
      if (row.is_active !== 1) {
        if (opts.strict) throw ApiError.badRequest(translate(lang, "order.unavailable", { product: row.name }), "PRODUCT_UNAVAILABLE");
        skipped.push({ product_id: pid, reason: "inactive" });
        continue;
      }
      if (row.stock < quantity) {
        if (opts.strict) {
          throw ApiError.badRequest(
            translate(lang, "order.out_of_stock", { product: row.name, requested: quantity, available: Math.max(0, row.stock) }),
            "OUT_OF_STOCK",
            { product_id: row.id, requested: quantity, available: Math.max(0, row.stock) },
          );
        }
        skipped.push({ product_id: pid, reason: "out_of_stock" });
        continue;
      }
      const itemSubtotal = round2(Number(row.price) * quantity);
      subtotal += itemSubtotal;
      items.push({ product: shapeProduct(row), quantity, subtotal: itemSubtotal, unit_price: Number(row.price) });
    }

    subtotal = round2(subtotal);
    const rules = await deliveryRules();
    const deliveryFee = subtotal > 0 && rules.freeAbove > 0 && subtotal >= rules.freeAbove ? 0 : rules.fee;

    return {
      items,
      skipped,
      subtotal,
      delivery_fee: opts.strict ? deliveryFee : 0,
      total: round2(subtotal + (opts.strict ? deliveryFee : 0)),
      count: items.reduce((n, i) => n + i.quantity, 0),
      currency: "BDT",
      delivery: { areas: rules.areas, fee: rules.fee, free_shipping_threshold: rules.freeAbove },
    };
  },

  /** GET /api/shop/checkout/context */
  async checkoutContext(user: SafeUser) {
    const s = await loadSettings();
    const rules = await deliveryRules();
    return {
      success: true,
      delivery: {
        areas: rules.areas,
        fee: rules.fee,
        free_shipping_threshold: rules.freeAbove,
        currency: "BDT",
      },
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
  async placeOrder(
    user: SafeUser,
    body: Record<string, unknown>,
    lang?: string | null,
  ): Promise<{ orderId: string; message: string; total: number; subtotal: number; delivery_fee: number; payment: { reference: string; status: string } }> {
    const cart = (body.cart && typeof body.cart === "object" ? body.cart : {}) as Record<string, unknown>;
    // Rejections use 400 with a distinct `code`: the frontend renders a 400 as a
    // "warning" flash the shopper can act on (change the quantity, pick another
    // area), while any other 4xx becomes a "danger" flash. Codes stay stable so
    // clients can branch without parsing the localized message.
    if (!Object.keys(cart).length) {
      throw ApiError.badRequest(translate(lang, "order.empty_cart"), "EMPTY_CART");
    }

    const str = (k: string) => (body[k] == null ? "" : String(body[k])).trim();

    const upazilaNorm = str("upazila").toLowerCase();
    const rules = await deliveryRules();
    const deliveryOk = upazilaNorm ? rules.upazilas.some((u: string) => upazilaNorm.includes(u)) : true;
    if (!deliveryOk) {
      throw ApiError.badRequest(translate(lang, "order.area_not_served"), "DELIVERY_AREA_NOT_SERVED", {
        served: rules.areas,
      });
    }

    // Server-authoritative pricing: prices/quantities come from the DB, and a
    // line that cannot be honoured fails the checkout instead of vanishing.
    let priced: PricedCart;
    try {
      priced = await this.priceCart(cart, { strict: true, lang });
    } catch (err) {
      throw err;
    }
    if (!priced.items.length) {
      throw ApiError.badRequest(translate(lang, "order.empty_cart"), "EMPTY_CART");
    }
    const { subtotal, delivery_fee: deliveryFee, total } = priced;

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
    const orderItems = priced.items.map((it) => ({
      id: randomId(),
      order_id: orderId,
      product_id: it.product.id,
      product_name: it.product.name,
      product_image: it.product.image_file,
      price: it.unit_price,
      qty: it.quantity,
      line_total: it.subtotal,
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
      if (err instanceof OutOfStockError) {
        // Lost the stock race: the transaction rolled back, so nothing was
        // written and no stock moved. Tell the shopper exactly what is left.
        throw ApiError.badRequest(
          translate(lang, "order.out_of_stock", {
            product: err.productName,
            requested: err.requested,
            available: err.available,
          }),
          "OUT_OF_STOCK",
          { product_id: err.productId, requested: err.requested, available: err.available },
        );
      }
      throw err;
    }

    // Ledger entry so the order has an auditable charge from the moment it exists.
    const charge = await paymentService.ensureCharge(orderId);

    const initials = user.name.split(/\s+/).map((w) => w[0]?.toUpperCase() || "").slice(0, 2).join("");
    await activityRepo.create("order", user.id, `New shop order #${orderId}`, {
      detail: `${initials} • ${str("upazila") || user.upazila || "Kalai"} • ৳${total.toFixed(0)}`,
      link: "/shop/my-orders",
    });

    // Buyer confirmation + admin alert. Both go through the outbox, so a slow or
    // down SMTP host can never block or fail a placed order.
    void emailService.orderConfirmation(orderId);
    void emailService.adminAlert(
      "New shop order",
      `${user.name} placed order ${orderId} for ৳${total.toFixed(2)} (${pm || "cash"}). Review it in Admin → Orders.`,
    );
    void notificationService.emit({
      event: "order_placed",
      userIds: [user.id],
      toAdmins: true,
      params: { id: orderId, total: `৳${total.toFixed(2)}` },
      entityId: orderId,
      dedupeKey: `order-placed:${orderId}`,
    });
    void notificationService.emit({
      event: "admin_new_order",
      toAdmins: true,
      params: { id: orderId, total: `৳${total.toFixed(2)}`, name: user.name },
      entityId: orderId,
      dedupeKey: `admin-new-order:${orderId}`,
    });

    logger.info("order: placed", { order: orderId, total, user: user.id, items: priced.items.length });

    return {
      orderId,
      message: translate(lang, "order.placed"),
      total,
      subtotal,
      delivery_fee: deliveryFee,
      payment: { reference: charge?.reference || orderId, status: charge?.status || "pending" },
    };
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

  /**
   * POST /api/shop/orders/:id/cancel — the owner cancels an order that has not
   * entered fulfilment yet. Stock is restored in the same transaction that
   * flips the status, so a retried/double cancel cannot restock twice. Admins
   * have their own status endpoint (any state) — this one is user-scoped.
   */
  async cancelOwnOrder(user: SafeUser, orderId: string, lang?: string | null): Promise<{ message: string }> {
    const row = await orderRepo.findById(orderId);
    if (!row) throw ApiError.notFound(translate(lang, "order.not_found"), "ORDER_NOT_FOUND");
    if (row.user_id !== user.id) {
      throw ApiError.forbidden(translate(lang, "order.own_only"), "OWN_ORDERS_ONLY");
    }
    if (row.status !== "pending") {
      throw ApiError.conflict(translate(lang, "order.not_cancellable"), "ORDER_NOT_CANCELLABLE");
    }
    // Atomic claim: only the caller that actually flipped pending → cancelled
    // may restore stock or close the ledger row.
    const claimed = await orderRepo.cancelByUserTx(orderId);
    if (!claimed) {
      throw ApiError.conflict(translate(lang, "order.not_cancellable"), "ORDER_NOT_CANCELLABLE");
    }
    await paymentService.cancelCharge(orderId);
    await activityRepo.create("order_cancel", user.id, `Order ${orderId} was cancelled by the customer`);
    void notificationService.emit({
      event: "order_cancelled",
      userIds: [user.id],
      toAdmins: true,
      params: { id: orderId, status: "cancelled" },
      entityId: orderId,
      dedupeKey: `order-cancelled:${orderId}`,
    });
    void emailService.orderStatus(orderId, "cancelled");
    logger.info("order: cancelled by user", { order: orderId, user: user.id });
    return { message: translate(lang, "order.cancelled") };
  },

  // ---------- admin: products (multipart image) ----------

  async adminProducts() {
    const rows = await productRepo.all();
    return { success: true, products: rows.map(shapeProduct) };
  },

  async adminProductCreate(
    actor: SafeUser,
    fields: Record<string, unknown>,
    imageFile: string | null,
  ): Promise<{ message: string; id: string; product: ReturnType<typeof shapeProduct> }> {
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
    // The created row is returned: without its id the caller cannot link to the
    // product it just made (the panel has to reload the whole catalogue to find
    // it), and an API client cannot chain create → update.
    const created = await productRepo.findById(id);
    return { message: "✅ Product added successfully!", id, product: created ? shapeProduct(created) : shapeProduct({ ...(fields as object), id } as ProductRow) };
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

  async adminConfirmPayment(actor: SafeUser, id: string, ip?: string | null): Promise<string> {
    const row = await orderRepo.findById(id);
    if (!row) throw ApiError.notFound("Order not found.", "ORDER_NOT_FOUND");
    if (row.payment_status === "confirmed") return "ℹ️ Payment already confirmed.";
    // The payment service owns the ledger row, the audit entry, the buyer
    // notification and the receipt email — confirming here would double-write.
    const out = await paymentService.confirmOrderPayment(actor, id, { ip: ip ?? null });
    await activityRepo.create("order_payment", actor.id, `Payment confirmed for order ${id}`);
    return out.message;
  },

  async adminOrderStatus(actor: SafeUser, id: string, status: string, lang?: string | null): Promise<string> {
    const valid = ["pending", "processing", "shipped", "delivered", "cancelled"];
    if (!valid.includes(status)) throw ApiError.badRequest(`Invalid status (expected one of: ${valid.join(", ")}).`, "BAD_STATUS");
    const row = await orderRepo.findById(id);
    if (!row) throw ApiError.notFound(translate(lang, "order.not_found"), "ORDER_NOT_FOUND");
    if (row.status === status) return translate(lang, "order.status_updated", { status });

    // Status flip + restock-on-cancel in one transaction, guarded by the
    // transition itself so concurrent cancels cannot restore stock twice.
    const out = await orderRepo.setStatusTx(id, status, {
      paymentStatus: status === "cancelled" ? row.payment_status : undefined,
    });
    if (!out.changed) return translate(lang, "order.status_updated", { status });

    if (status === "cancelled") await paymentService.markFailed(id, "Order cancelled by admin");
    await auditRepo
      .create({
        actorId: actor.id,
        actorRole: actor.role || null,
        action: "order.status",
        entityType: "order",
        entityId: id,
        summary: `Order status ${row.status} → ${status}`,
        meta: { from: row.status, to: status, restocked: out.restocked },
      })
      .catch(() => {});
    await activityRepo.create("order_status", actor.id, `Order ${id} → ${status}`);

    if (row.user_id) {
      void notificationService.emit({
        event: status === "cancelled" ? "order_cancelled" : "order_status",
        userIds: [row.user_id],
        params: { id, status },
        entityType: "order",
        entityId: id,
        dedupeKey: `order-status:${id}:${status}`,
      });
      void emailService.orderStatus(id, status);
    }
    logger.info("order: status changed by admin", { order: id, from: row.status, to: status, actor: actor.id, restocked: out.restocked });
    return translate(lang, "order.status_updated", { status });
  },

  // legacy helpers (kept for the admin dashboard service)
  async withItems(orderId: string): Promise<Order> {
    const row = await orderRepo.findById(orderId);
    if (!row) throw ApiError.notFound("Order not found", "ORDER_NOT_FOUND");
    return orderWithItems(row);
  },
};
