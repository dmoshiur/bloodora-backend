import { Router } from "express";
import { ah } from "../utils/async.js";
import { requireAdmin, requireSuperAdmin } from "../middleware/admin.js";
import { upload } from "../uploads/uploads.js";
import * as c from "../controllers/admin.controller.js";

/**
 * Mounted at /api/admin. Paths mirror the original backend admin API
 * (dashboard, settings, branding, smtp, content, activity, notice,
 * user management, impersonation, backup).
 */
const router = Router();

router.use(requireAdmin);

// Dashboard + settings + branding
router.get("/dashboard", ah(c.dashboard));
router.get("/settings", ah(c.settingsGet));
router.post("/settings", ah(c.settingsPost));
router.get("/branding", ah(c.brandingGet));
router.post("/branding", upload.fields([{ name: "logo", maxCount: 1 }, { name: "favicon", maxCount: 1 }]), ah(c.brandingPost));

// SMTP & email
router.get("/smtp", ah(c.smtpGet));
router.post("/smtp", ah(c.smtpPost));
router.post("/smtp/test", ah(c.smtpTest));
router.get("/smtp/log", ah(c.smtpLog));

// Content manager
router.get("/content/antid", ah(c.antidList));
router.post("/content/antid", ah(c.antidCreate));
router.put("/content/antid/:id", ah(c.antidUpdate));
router.delete("/content/antid/:id", ah(c.antidDelete));
router.get("/content/resources", ah(c.resourcesList));
router.post("/content/resources", ah(c.resourceCreate));
router.put("/content/resources/:id", ah(c.resourceUpdate));
router.delete("/content/resources/:id", ah(c.resourceDelete));

// Live activity
router.get("/activity", ah(c.activityEvents));
router.post("/activity/announce", ah(c.activityAnnounce));

// Site notice (clear is a GET — original contract)
router.post("/notice", ah(c.noticeSet));
router.get("/notice/clear", ah(c.noticeClear));

// Donor verification (any admin)
router.post("/verify-donor/:id", ah(c.verifyDonor));

// Super admin only
router.post("/promote/:id", requireSuperAdmin, ah(c.promote));
router.post("/demote/:id", requireSuperAdmin, ah(c.demote));
router.delete("/user/:id", requireSuperAdmin, ah(c.userDelete));
router.post("/user/update/:id", requireSuperAdmin, ah(c.userUpdate));
router.get("/user/details/:id", requireSuperAdmin, ah(c.userDetails));
router.post("/create-admin", requireSuperAdmin, ah(c.createAdmin));
router.post("/impersonate/:id", requireSuperAdmin, ah(c.impersonate));
router.post("/switch-back", requireSuperAdmin, ah(c.switchBack));
router.get("/backup", requireSuperAdmin, ah(c.backup));

export default router;
