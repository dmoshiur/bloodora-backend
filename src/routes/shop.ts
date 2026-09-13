import { Router } from "express";
import { ah } from "../utils/async.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import { singleUpload } from "../uploads/uploads.js";
import {
  listProducts,
  getProduct,
  listCategories,
  validateItem,
  resolveCart,
  checkoutContext,
  placeOrder,
  myOrders,
  getOrder,
  cancelOrder,
  submitReview,
  listAdminProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  listAdminOrders,
  getAdminOrder,
  confirmPayment,
  updateOrderStatus,
} from "../controllers/shop.controller.js";

const router = Router();

// ---- public shop ----
router.get("/products", ah(listProducts));
router.get("/products/:id", ah(getProduct));
router.get("/categories", ah(listCategories));
router.post("/cart/validate-item", rateLimit({ scope: "cart-validate", windowMs: 60 * 1000, max: 120 }), ah(validateItem));
router.post("/cart/resolve", rateLimit({ scope: "cart-resolve", windowMs: 60 * 1000, max: 120 }), ah(resolveCart));

// ---- checkout & orders (logged-in users) ----
router.get("/checkout/context", requireAuth, ah(checkoutContext));
router.post("/orders", requireAuth, rateLimit({ scope: "order-place", windowMs: 15 * 60 * 1000, max: 10 }), ah(placeOrder));
router.get("/orders/mine", requireAuth, ah(myOrders));
router.get("/orders/:id", requireAuth, ah(getOrder));
router.post("/orders/:id/cancel", requireAuth, ah(cancelOrder));

// ---- reviews (user-facing; also /api/reviews) ----
router.post("/reviews", requireAuth, ah(submitReview));

// ---- shop admin (products + orders). Mounted at /api/shop/admin and
//      /api/admin (original contract: /api/admin/products, /api/admin/orders). ----
export const adminRouter = Router();

adminRouter.get("/products", requireAuth, requireAdmin, ah(listAdminProducts));
adminRouter.post("/products", requireAuth, requireAdmin, singleUpload("image"), ah(createProduct));
adminRouter.put("/products/:id", requireAuth, requireAdmin, singleUpload("image"), ah(updateProduct));
adminRouter.delete("/products/:id", requireAuth, requireAdmin, ah(deleteProduct));

adminRouter.get("/orders", requireAuth, requireAdmin, ah(listAdminOrders));
adminRouter.get("/orders/:id", requireAuth, requireAdmin, ah(getAdminOrder));
adminRouter.post("/orders/:id/confirm-payment", requireAuth, requireAdmin, ah(confirmPayment));
adminRouter.post("/orders/:id/status", requireAuth, requireAdmin, ah(updateOrderStatus));
adminRouter.patch("/orders/:id/status", requireAuth, requireAdmin, ah(updateOrderStatus));

router.use("/admin", adminRouter);

export default router;
