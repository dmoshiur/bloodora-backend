// ==================== BloodOra Backend API - Blood Requests ====================
import express from "express";
import { get, all, run } from "../db.js";
import { requireAuth, optionalAuth } from "../auth.js";
import { tryCatch } from "../utils.js";

const router = express.Router();

// GET /api/blood-requests?bg=&dist=&division=&urgent=
router.get("/", (req, res) =>
  tryCatch(res, async () => {
    const { bg, dist, division, urgent } = req.query;
    let sql = "SELECT * FROM blood_requests WHERE is_fulfilled=0 AND datetime(needed_by) >= datetime('now')";
    const params = [];
    if (bg) { sql += " AND blood_group=?"; params.push(bg); }
    if (division) { sql += " AND location_division LIKE ?"; params.push(`%${division}%`); }
    if (dist) { sql += " AND location_district LIKE ?"; params.push(`%${dist}%`); }
    if (urgent === "true") { sql += " AND is_urgent=1"; }
    sql += " ORDER BY is_urgent DESC, datetime(needed_by) ASC";
    const requests = await all(sql, params);
    res.json({ success: true, requests });
  })
);

// GET /api/blood-requests/urgent
router.get("/urgent", (req, res) =>
  tryCatch(res, async () => {
    const urgent_requests = await all(
      "SELECT * FROM blood_requests WHERE is_urgent=1 AND is_fulfilled=0 AND status!='cancelled' ORDER BY datetime(needed_by) ASC"
    );
    res.json({ success: true, requests: urgent_requests });
  })
);

// POST /api/blood-requests — create (guests allowed, like the original form)
router.post("/", optionalAuth, (req, res) =>
  tryCatch(res, async () => {
    const {
      patient_name, blood_group, hospital_name, hospital_address, contact_person,
      contact_phone, contact_email, needed_by, division, district, upazila,
      is_urgent, urgent_reason, additional_info, patient_relation, quantity,
    } = req.body;

    const required = {
      "Patient Name": patient_name, "Blood Group": blood_group, "Hospital Name": hospital_name,
      "Contact Person": contact_person, "Contact Phone": contact_phone, "Needed By": needed_by,
      "Division": division, "District": district, "Upazila": upazila,
    };
    const missing = Object.entries(required).filter(([, v]) => !v || !String(v).trim()).map(([k]) => k);
    if (missing.length) {
      return res.status(400).json({ success: false, message: `❌ Please fill all required fields: ${missing.join(", ")}` });
    }

    let needed_dt = needed_by;
    try { needed_dt = new Date(needed_by).toISOString(); } catch (e) { /* keep raw */ }

    const isUrgentVal = is_urgent ? 1 : 0;
    const now = new Date().toISOString();
    const requester_id = req.user ? req.user.id : null;

    await run(
      `INSERT INTO blood_requests (requester_id, patient_name, patient_relation, blood_group, quantity, hospital_name, hospital_address, contact_person, contact_phone, contact_email, is_urgent, urgent_reason, needed_by, location_division, location_district, location_upazila, additional_info, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [requester_id, patient_name, patient_relation || "Self", blood_group, quantity || "1 unit", hospital_name, hospital_address || `${upazila}, ${district}, ${division}`, contact_person, contact_phone, contact_email || null, isUrgentVal, urgent_reason || null, needed_dt, division, district, upazila, additional_info || null, "open", now, now]
    );

    res.json({
      success: true,
      type: isUrgentVal ? "warning" : "success",
      message: isUrgentVal
        ? "🚨 URGENT blood request submitted! Donors will be notified."
        : "✅ Blood request submitted successfully! Thank you.",
    });
  })
);

// GET /api/blood-requests/:id
router.get("/:id", (req, res) =>
  tryCatch(res, async () => {
    const request = await get(
      "SELECT br.*, u.name as requester_name FROM blood_requests br LEFT JOIN users u ON br.requester_id=u.id WHERE br.id=?",
      [req.params.id]
    );
    if (!request) return res.status(404).json({ success: false, message: "Request not found." });
    request.is_urgent = !!request.is_urgent;
    request.is_fulfilled = !!request.is_fulfilled;
    res.json({ success: true, request });
  })
);

// POST /api/blood-requests/:id/fulfill
router.post("/:id/fulfill", requireAuth, (req, res) =>
  tryCatch(res, async () => {
    const br = await get("SELECT * FROM blood_requests WHERE id=?", [req.params.id]);
    if (!br) return res.status(404).json({ success: false, message: "Request not found." });
    if (br.is_fulfilled) return res.json({ success: true, type: "info", message: "ℹ️ Already fulfilled." });
    const now = new Date().toISOString();
    await run("UPDATE blood_requests SET is_fulfilled=1, fulfilled_at=?, fulfilled_by=?, status='fulfilled', updated_at=? WHERE id=?", [now, req.user.id, now, req.params.id]);
    res.json({
      success: true,
      message: br.is_urgent
        ? "✅ Urgent request marked as fulfilled. Thank you for donating!"
        : "✅ Blood request marked as fulfilled. Thank you!",
    });
  })
);

// POST /api/blood-requests/:id/cancel
router.post("/:id/cancel", requireAuth, (req, res) =>
  tryCatch(res, async () => {
    const br = await get("SELECT * FROM blood_requests WHERE id=?", [req.params.id]);
    if (!br) return res.status(404).json({ success: false, message: "Request not found." });
    if (br.requester_id === req.user.id || req.user.is_admin) {
      await run("UPDATE blood_requests SET status='cancelled', is_fulfilled=1, updated_at=? WHERE id=?", [new Date().toISOString(), req.params.id]);
      return res.json({ success: true, type: "info", message: "ℹ️ Blood request cancelled." });
    }
    res.status(403).json({ success: false, message: "❌ You do not have permission to cancel this request." });
  })
);

// POST /api/blood-requests/urgent-contact — contact form on the urgent page
router.post("/urgent-contact", optionalAuth, (req, res) =>
  tryCatch(res, async () => {
    const { subject, message, email } = req.body;
    if (req.user) {
      await run(
        `INSERT INTO messages (sender_id, recipient_id, subject, content, is_admin_message) VALUES (?,?,?, ?,1)`,
        [req.user.id, null, `🚨 URGENT PAGE: ${subject || "Urgent Inquiry"}`, `From: ${email || req.user.email}\n\n${message}`]
      );
    }
    res.json({ success: true, message: "✅ Your message has been sent to the BloodOra admin team!" });
  })
);

export default router;
