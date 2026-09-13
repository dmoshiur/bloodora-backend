import { Router } from "express";
import { ah } from "../utils/async.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import * as c from "../controllers/payment.controller.js";

/** Mounted at /api/payments — the caller's own ledger. */
export const router = Router();
router.use(requireAuth);
router.get("/me", ah(c.mine));
router.get("/order/:id", ah(c.forOrder));

/**
 * Mounted at /api/admin.
 *
 * `POST /orders/:id/confirm-payment` stays on the shop admin router (the
 * frontend already calls it there and that handler now delegates to the payment
 * service), so only the ledger reads and the refund live here.
 */
export const adminRouter = Router();
adminRouter.use(requireAuth);

adminRouter.get("/payments", requirePermission("payments.view"), ah(c.adminList));
adminRouter.get("/payments/summary", requirePermission("payments.view"), ah(c.adminSummary));
adminRouter.get("/payments/order/:id", requirePermission("payments.view"), ah(c.adminOrderLedger));
adminRouter.post("/payments/order/:id/refund", requirePermission("payments.refund"), ah(c.adminRefund));
