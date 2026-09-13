import type { Request, Response } from "express";
import { shopService } from "../services/shop.service.js";
import { reviewService } from "../services/review.service.js";
import { uploadService } from "../services/upload.service.js";
import { readUpload } from "../uploads/uploads.js";
import { str } from "../utils/validate.js";
import { ApiError } from "../utils/errors.js";

// ---------- public ----------

/** GET /api/shop/products?category=&search= */
export async function listProducts(req: Request, res: Response): Promise<void> {
  res.json(await shopService.productsList({ category: str(req.query.category), search: str(req.query.search) }));
}

/** GET /api/shop/products/:id */
export async function getProduct(req: Request, res: Response): Promise<void> {
  res.json(await shopService.productDetail(req.params.id));
}

/** GET /api/shop/categories — live category list with counts. */
export async function listCategories(_req: Request, res: Response): Promise<void> {
  res.json(await shopService.categories());
}


/** POST /api/shop/cart/validate-item — {product_id}. */
export async function validateItem(req: Request, res: Response): Promise<void> {
  const product_id = str(req.body.product_id) || str(req.body.id);
  if (!product_id) throw ApiError.badRequest("product_id is required.", "FIELDS_REQUIRED");
  await shopService.validateItem(product_id);
  res.json({ success: true, ok: true });
}

/** POST /api/shop/cart/resolve — {cart: {id: qty}}. */
export async function resolveCart(req: Request, res: Response): Promise<void> {
  const cart = (req.body?.cart && typeof req.body.cart === "object" ? req.body.cart : {}) as Record<string, unknown>;
  res.json({ success: true, ...(await shopService.resolveCart(cart)) });
}

/** GET /api/shop/checkout/context */
export async function checkoutContext(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  res.json(await shopService.checkoutContext(req.user));
}

// ---------- orders ----------

/** POST /api/shop/orders — checkout. */
export async function placeOrder(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const out = await shopService.placeOrder(req.user, req.body as Record<string, unknown>);
  res.json({ success: true, ...out });
}

/** GET /api/shop/orders/mine */
export async function myOrders(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  res.json(await shopService.myOrders(req.user));
}

/** GET /api/shop/orders/:id */
export async function getOrder(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  res.json(await shopService.orderDetail(req.user, req.params.id));
}

/** POST /api/shop/orders/:id/cancel — owner cancels while pending (restocks). */
export async function cancelOrder(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  res.json({ success: true, ...(await shopService.cancelOwnOrder(req.user, req.params.id)) });
}

// ---------- reviews (user-facing) ----------

/** POST /api/shop/reviews — legacy submit (kept). */
export async function submitReview(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const out = await reviewService.submit(req.user, req.body as Record<string, unknown>);
  res.json({ success: true, ...out });
}

// ---------- admin: products (multipart: name, price, stock, category, description + image) ----------

/** GET /api/admin/products */
export async function listAdminProducts(_req: Request, res: Response): Promise<void> {
  res.json(await shopService.adminProducts());
}

/** POST /api/admin/products */
export async function createProduct(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const file = readUpload(req);
  const imageFile = file ? await uploadService.store(file) : null;
  const message = await shopService.adminProductCreate(req.user, req.body as Record<string, unknown>, imageFile);
  res.json({ success: true, message });
}

/** PUT /api/admin/products/:id */
export async function updateProduct(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const file = readUpload(req);
  const imageFile = file ? await uploadService.store(file) : null;
  const message = await shopService.adminProductUpdate(req.user, req.params.id, req.body as Record<string, unknown>, imageFile);
  res.json({ success: true, message });
}

/** DELETE /api/admin/products/:id */
export async function deleteProduct(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const message = await shopService.adminProductDelete(req.user, req.params.id);
  res.json({ success: true, message });
}

// ---------- admin: orders ----------

/** GET /api/admin/orders?status= */
export async function listAdminOrders(req: Request, res: Response): Promise<void> {
  res.json(await shopService.adminOrders(str(req.query.status) || undefined));
}

/** GET /api/admin/orders/:id */
export async function getAdminOrder(req: Request, res: Response): Promise<void> {
  res.json(await shopService.adminOrder(req.params.id));
}

/** POST /api/admin/orders/:id/confirm-payment */
export async function confirmPayment(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const message = await shopService.adminConfirmPayment(req.user, req.params.id);
  res.json({ success: true, message });
}

/** POST /api/admin/orders/:id/status — {status}. */
export async function updateOrderStatus(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const message = await shopService.adminOrderStatus(req.user, req.params.id, str(req.body.status) ?? "");
  res.json({ success: true, message });
}
