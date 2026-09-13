import { Router } from "express";
import { ah } from "../utils/async.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/admin.js";
import {
  listRequests,
  createRequest,
  myRequests,
  urgentList,
  getRequest,
  fulfillRequest,
  cancelRequest,
  urgentContact,
  getAdminRequest,
  setRequestStatus,
  deleteRequest,
} from "../controllers/blood.controller.js";

const router = Router();

// Mounted at /api/blood-requests.
router.get("/", ah(listRequests));
router.get("/urgent", ah(urgentList));
router.post(
  "/",
  optionalAuth,
  rateLimit({ scope: "blood-create", windowMs: 15 * 60 * 1000, max: 10 }),
  ah(createRequest),
);
router.post("/urgent-contact", optionalAuth, rateLimit({ scope: "urgent-contact", windowMs: 15 * 60 * 1000, max: 10 }), ah(urgentContact));
router.get("/mine", requireAuth, ah(myRequests));
router.get("/:id", ah(getRequest));
router.post("/:id/fulfill", requireAuth, ah(fulfillRequest));
router.post("/:id/cancel", requireAuth, ah(cancelRequest));

// Mounted at /api/admin/blood-requests.
export const adminRouter = Router();
adminRouter.get("/:id", requireAuth, requireAdmin, ah(getAdminRequest));
adminRouter.patch("/:id/status", requireAuth, requireAdmin, ah(setRequestStatus));
adminRouter.delete("/:id", requireAuth, requireAdmin, ah(deleteRequest));

export default router;
