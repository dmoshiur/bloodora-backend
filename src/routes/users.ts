import { Router } from "express";
import { ah } from "../utils/async.js";
import { requireAuth } from "../middleware/auth.js";
import { singleUpload } from "../uploads/uploads.js";
import { listDonors, publicProfile, updateSelf, toggleStatus, applyVerification } from "../controllers/users.controller.js";

const router = Router();
const donorRouter = Router();

// ---------- /api/donors (public directory) ----------
donorRouter.get("/", ah(listDonors));

// ---------- /api/users ----------
router.get("/:id", ah(publicProfile));
router.put("/me", requireAuth, singleUpload("profile_pic"), ah(updateSelf));
router.post("/me/toggle-status", requireAuth, ah(toggleStatus));
router.post("/me/apply-verification", requireAuth, ah(applyVerification));

export default router;
export { donorRouter };
