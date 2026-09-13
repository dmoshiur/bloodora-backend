import { Router } from "express";
import { ah } from "../utils/async.js";
import { requirePermission, requireAnyPermission } from "../middleware/rbac.js";
import { upload } from "../uploads/uploads.js";
import * as c from "../controllers/admin.controller.js";

/**
 * Mounted at /api/admin. Paths mirror the original backend admin API
 * (dashboard, settings, branding, smtp, content, activity, notice,
 * user management, impersonation, backup).
 */
const router = Router();

// No blanket `requireAdmin`: each path declares the permission it needs. The
// seeded `admin` role holds all of the non-super keys below and `super_admin`
// holds every key, so existing accounts keep exactly the access they had — but a
// custom role can now be granted, say, `content.manage` alone.
//
// Dashboard + settings + branding
router.get("/dashboard", requireAnyPermission("users.view", "orders.view", "settings.view", "content.view", "shop.view"), ah(c.dashboard));
router.get("/settings", requirePermission("settings.view"), ah(c.settingsGet));
router.post("/settings", requirePermission("settings.manage"), ah(c.settingsPost));
router.get("/branding", requirePermission("settings.view"), ah(c.brandingGet));
router.post("/branding", requirePermission("settings.branding"), upload.fields([{ name: "logo", maxCount: 1 }, { name: "favicon", maxCount: 1 }]), ah(c.brandingPost));

// SMTP & email
router.get("/smtp", requirePermission("settings.smtp"), ah(c.smtpGet));
router.post("/smtp", requirePermission("settings.smtp"), ah(c.smtpPost));
router.post("/smtp/test", requirePermission("settings.smtp"), ah(c.smtpTest));
router.get("/smtp/log", requirePermission("settings.smtp"), ah(c.smtpLog));

// Content manager
router.get("/content/antid", requirePermission("content.view"), ah(c.antidList));
router.post("/content/antid", requirePermission("content.manage"), ah(c.antidCreate));
router.put("/content/antid/:id", requirePermission("content.manage"), ah(c.antidUpdate));
router.delete("/content/antid/:id", requirePermission("content.manage"), ah(c.antidDelete));
router.get("/content/resources", requirePermission("content.view"), ah(c.resourcesList));
router.post("/content/resources", requirePermission("content.manage"), ah(c.resourceCreate));
router.put("/content/resources/:id", requirePermission("content.manage"), ah(c.resourceUpdate));
router.delete("/content/resources/:id", requirePermission("content.manage"), ah(c.resourceDelete));

// Live activity
router.get("/activity", requirePermission("content.view"), ah(c.activityEvents));
router.post("/activity/announce", requirePermission("notice.manage"), ah(c.activityAnnounce));

// Site notice (clear is a GET — original contract)
router.post("/notice", requirePermission("notice.manage"), ah(c.noticeSet));
router.get("/notice/clear", requirePermission("notice.manage"), ah(c.noticeClear));

// Donor verification (any admin)
router.post("/verify-donor/:id", requirePermission("users.verify"), ah(c.verifyDonor));

// Super admin only
// Account administration — the keys below are granted ONLY to the seeded
// super_admin role, which reproduces the old `requireSuperAdmin` exactly.
router.post("/promote/:id", requirePermission("users.role.assign"), ah(c.promote));
router.post("/demote/:id", requirePermission("users.role.assign"), ah(c.demote));
router.delete("/user/:id", requirePermission("users.delete"), ah(c.userDelete));
router.post("/user/update/:id", requirePermission("users.manage"), ah(c.userUpdate));
router.get("/user/details/:id", requirePermission("users.view"), ah(c.userDetails));
router.post("/create-admin", requirePermission("users.create_admin"), ah(c.createAdmin));
router.post("/impersonate/:id", requirePermission("users.impersonate"), ah(c.impersonate));
// switch-back is called with the ADMIN's own token (the frontend keeps it in the
// session while impersonating), so the impersonator's permission is what counts.
router.post("/switch-back", requirePermission("users.impersonate"), ah(c.switchBack));
router.get("/backup", requirePermission("system.backup"), ah(c.backup));

// Mail outbox + housekeeping. Reading the queue belongs with the mail settings;
// triggering a sweep is a system operation.
router.get("/mail/outbox", requirePermission("settings.smtp"), ah(c.mailOutbox));
router.post("/mail/flush", requirePermission("system.maintenance"), ah(c.mailFlush));
router.post("/maintenance", requirePermission("system.maintenance"), ah(c.maintenance));

export default router;
