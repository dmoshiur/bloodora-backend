import { Router, type Request } from "express";
import { ah } from "../utils/async.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireAuth } from "../middleware/auth.js";
import { singleUpload } from "../uploads/uploads.js";
import { str } from "../utils/validate.js";
import {
  register,
  login,
  logout,
  me,
  updateProfile,
  changePassword,
  uploadProfileImage,
  setProfileImage,
  forgotPassword,
  validateReset,
  resetPassword,
  requestVerification,
  verifyEmail,
} from "../controllers/auth.controller.js";

/** The submitted email, so a credential-stuffing attempt is bucketed per account. */
const byEmail = (req: Request): string | undefined => str((req.body as Record<string, unknown> | undefined)?.email);

const router = Router();

// Rate limits are per-route (login/register only) so profile updates, logouts,
// etc. are not throttled.
// `shared: true` adds the database-backed window on top of the in-process one:
// on serverless each invocation can be a fresh process, so an in-memory counter
// alone would reset on every cold start and throttle nothing.
router.post(
  "/register",
  rateLimit({ scope: "register", windowMs: 15 * 60 * 1000, max: 5, shared: true, keyBy: byEmail }),
  singleUpload("profile_pic"),
  ah(register),
);
router.post("/login", rateLimit({ scope: "login", windowMs: 15 * 60 * 1000, max: 10, shared: true, keyBy: byEmail }), ah(login));

// ---- self-service password reset (no session required) ----
router.post(
  "/forgot-password",
  rateLimit({ scope: "password-reset", windowMs: 15 * 60 * 1000, max: 5, shared: true, keyBy: byEmail }),
  ah(forgotPassword),
);
router.get("/reset-password/validate", rateLimit({ scope: "reset-validate", windowMs: 15 * 60 * 1000, max: 30, shared: true }), ah(validateReset));
router.post(
  "/reset-password",
  rateLimit({ scope: "password-reset", windowMs: 15 * 60 * 1000, max: 5, shared: true }),
  ah(resetPassword),
);

// ---- email verification. Emailed links are GETs, so both verbs are served. ----
router.post("/verify-email/request", requireAuth, rateLimit({ scope: "verify-request", windowMs: 15 * 60 * 1000, max: 5, shared: true }), ah(requestVerification));
router.get("/verify-email", rateLimit({ scope: "verify-email", windowMs: 15 * 60 * 1000, max: 20, shared: true }), ah(verifyEmail));
router.post("/verify-email", rateLimit({ scope: "verify-email", windowMs: 15 * 60 * 1000, max: 20, shared: true }), ah(verifyEmail));

// requireAuth first: logout revokes the caller's session, so the caller must
// be resolved (cookie OR bearer) before we can revoke anything.
router.post("/logout", requireAuth, ah(logout));
router.get("/me", requireAuth, ah(me));
router.patch("/profile", requireAuth, ah(updateProfile));
router.post("/password", requireAuth, ah(changePassword));
router.post("/profile/image", requireAuth, uploadProfileImage, ah(setProfileImage));

export default router;
