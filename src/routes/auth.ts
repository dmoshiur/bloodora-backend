import { Router } from "express";
import { ah } from "../utils/async.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { requireAuth } from "../middleware/auth.js";
import { singleUpload } from "../uploads/uploads.js";
import {
  register,
  login,
  logout,
  me,
  updateProfile,
  changePassword,
  uploadProfileImage,
  setProfileImage,
} from "../controllers/auth.controller.js";

const router = Router();

// Rate limits are per-route (login/register only) so profile updates, logouts,
// etc. are not throttled.
router.post("/register", rateLimit({ scope: "register", windowMs: 15 * 60 * 1000, max: 5 }), singleUpload("profile_pic"), ah(register));
router.post("/login", rateLimit({ scope: "login", windowMs: 15 * 60 * 1000, max: 10 }), ah(login));

// requireAuth first: logout revokes the caller's session, so the caller must
// be resolved (cookie OR bearer) before we can revoke anything.
router.post("/logout", requireAuth, ah(logout));
router.get("/me", requireAuth, ah(me));
router.patch("/profile", requireAuth, ah(updateProfile));
router.post("/password", requireAuth, ah(changePassword));
router.post("/profile/image", requireAuth, uploadProfileImage, ah(setProfileImage));

export default router;
