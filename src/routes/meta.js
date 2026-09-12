// ==================== BloodOra Backend API - Public Meta / Content ====================
import express from "express";
import { get, all } from "../db.js";
import { optionalAuth } from "../auth.js";
import { divisions, districts, bangladeshData } from "../locations.js";
import { tryCatch } from "../utils.js";

const router = express.Router();

// GET /api/health
router.get("/health", async (req, res) => {
  try {
    await get("SELECT 1 as ok");
    res.json({ status: "healthy", database: "connected", service: "bloodora-backend", time: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: "unhealthy", error: e.message });
  }
});

// GET /api/meta/settings — public site settings (footer, contact page, guidelines, faq)
router.get("/settings", (req, res) =>
  tryCatch(res, async () => {
    const settings = await get("SELECT * FROM site_settings LIMIT 1");
    res.json({ success: true, settings: settings || null });
  })
);

// GET /api/meta/locations — Bangladesh divisions/districts/upazilas for cascading dropdowns
router.get("/locations", (req, res) => {
  res.json({ success: true, divisions, districts, bangladeshData });
});

// GET /api/meta/home — everything the homepage needs in one call
router.get("/home", (req, res) =>
  tryCatch(res, async () => {
    const settings = await get("SELECT * FROM site_settings LIMIT 1");
    const notice = await get("SELECT * FROM site_notice WHERE active=1 LIMIT 1");
    const total_donors_row = await get("SELECT COUNT(*) as c FROM users WHERE can_donate=1 AND is_verified=1");
    const urgent_row = await get("SELECT COUNT(*) as c FROM blood_requests WHERE is_urgent=1 AND is_fulfilled=0");
    const recent_donors = await all("SELECT * FROM users WHERE can_donate=1 AND is_verified=1 ORDER BY created_at DESC LIMIT 6");
    const recent_requests = await all("SELECT * FROM blood_requests WHERE is_fulfilled=0 ORDER BY is_urgent DESC, needed_by ASC LIMIT 5");
    res.json({
      success: true,
      settings: settings || null,
      notice: notice || null,
      total_donors: total_donors_row.c,
      urgent_requests: urgent_row.c,
      recent_donors,
      recent_requests,
    });
  })
);

// GET /api/meta/antid
router.get("/antid", (req, res) =>
  tryCatch(res, async () => {
    const antid_info = await all("SELECT * FROM anti_d_info");
    res.json({ success: true, antid_info });
  })
);

// GET /api/meta/resources?category=
router.get("/resources", (req, res) =>
  tryCatch(res, async () => {
    const cat = req.query.category;
    let sql = "SELECT * FROM resources";
    const params = [];
    if (cat) {
      sql += " WHERE category=?";
      params.push(cat);
    }
    sql += " ORDER BY is_featured DESC, created_at DESC";
    const resources = await all(sql, params);
    res.json({ success: true, resources });
  })
);

// GET /api/meta/chat-auth — identity for the live chat widget
router.get("/chat-auth", optionalAuth, (req, res) => {
  if (req.user) {
    return res.json({ uid: String(req.user.id), name: req.user.name, image: req.user.image_file || "default.jpg", is_admin: !!req.user.is_admin });
  }
  res.json({ uid: "guest_" + (req.ip || "").replace(/\./g, ""), name: "Guest User", image: "default.jpg", is_admin: false });
});

export default router;
