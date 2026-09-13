import { Router } from "express";
import { ah } from "../utils/async.js";
import { requireAuth } from "../middleware/auth.js";
import { singleUpload } from "../uploads/uploads.js";
import { listDonors, publicProfile, updateSelf, toggleStatus, applyVerification, dashboard, setPreferences } from "../controllers/users.controller.js";

const router = Router();
const donorRouter = Router();
/** Mounted at /api/user (singular) — the caller's own aggregate views. */
const userRouter = Router();

// ---------- /api/donors (public directory) ----------
donorRouter.get("/", ah(listDonors));

// ---------- /api/user ----------
// Kept on its own prefix: `/api/users/:id` is a public profile lookup, so a
// `/api/users/dashboard` path would be captured by `:id` and served as a
// (nonexistent) profile instead.
userRouter.use(requireAuth);
userRouter.get("/dashboard", ah(dashboard));

// ---------- /api/users ----------
router.get("/:id/public", ah(publicProfile)); // lightweight alias kept for the original contract
router.get("/:id", ah(publicProfile));
router.put("/me", requireAuth, singleUpload("profile_pic"), ah(updateSelf));
// Declared before `/:id` so "me" is never captured as a user id.
router.patch("/me/preferences", requireAuth, ah(setPreferences));
router.post("/me/preferences", requireAuth, ah(setPreferences));
router.post("/me/toggle-status", requireAuth, ah(toggleStatus));
router.post("/me/apply-verification", requireAuth, ah(applyVerification));

export default router;
export { donorRouter, userRouter };
