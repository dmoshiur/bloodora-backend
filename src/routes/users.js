// ==================== BloodOra Backend API - Donors / Users ====================
import express from "express";
import { get, all, run } from "../db.js";
import { requireAuth } from "../auth.js";
import { upload } from "../upload.js";
import { calculateAge, normalizeUser, publicUser, tryCatch } from "../utils.js";

const router = express.Router();

// GET /api/donors?bg=&dist=&upa=&age_min=
router.get("/", (req, res) =>
  tryCatch(res, async () => {
    const { bg, dist, upa, age_min } = req.query;
    let sql = "SELECT * FROM users WHERE can_donate=1 AND is_verified=1";
    const params = [];
    if (bg) { sql += " AND blood_group=?"; params.push(bg); }
    if (dist) { sql += " AND district LIKE ?"; params.push(`%${dist}%`); }
    if (upa) { sql += " AND upazila LIKE ?"; params.push(`%${upa}%`); }
    if (age_min) { sql += " AND age >= ?"; params.push(parseInt(age_min)); }
    sql += " ORDER BY created_at DESC";
    const users = await all(sql, params);
    res.json({ success: true, users });
  })
);

// GET /api/users/:id — public profile
router.get("/:id", (req, res) =>
  tryCatch(res, async () => {
    const user = await get("SELECT * FROM users WHERE id=?", [req.params.id]);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    res.json({ success: true, user: normalizeUser(user) });
  })
);

// PUT /api/users/me — edit own profile (multipart, optional field: profile_pic)
router.put("/me", requireAuth, upload.single("profile_pic"), (req, res) =>
  tryCatch(res, async () => {
    const { name, phone, holding, birth_certificate, date_of_birth } = req.body;
    let age = req.user.age;
    let dob = req.user.date_of_birth;
    if (date_of_birth) {
      dob = date_of_birth;
      age = calculateAge(date_of_birth) || age;
    }
    let image_file = req.user.image_file;
    if (req.file) image_file = req.file.filename;
    await run(
      `UPDATE users SET name=?, phone=?, address_holding=?, birth_certificate_number=?, date_of_birth=?, age=?, image_file=? WHERE id=?`,
      [name, phone, holding, birth_certificate, dob, age, image_file, req.user.id]
    );
    const updated = await get("SELECT * FROM users WHERE id=?", [req.user.id]);
    res.json({ success: true, user: normalizeUser(updated), message: "✅ Profile updated successfully!" });
  })
);

// POST /api/users/me/toggle-status
router.post("/me/toggle-status", requireAuth, (req, res) =>
  tryCatch(res, async () => {
    const newVal = req.user.can_donate ? 0 : 1;
    await run("UPDATE users SET can_donate=? WHERE id=?", [newVal, req.user.id]);
    res.json({ success: true, can_donate: !!newVal, message: `✅ Donation status updated: ${newVal ? "Available" : "Unavailable"}` });
  })
);

// POST /api/users/me/apply-verification
router.post("/me/apply-verification", requireAuth, (req, res) =>
  tryCatch(res, async () => {
    if (req.user.age && req.user.age >= 18) {
      return res.json({ success: true, type: "info", message: "ℹ️ Verification request submitted. Admin will review within 24 hours." });
    }
    res.status(400).json({ success: false, type: "warning", message: "⚠️ You must be 18+ to apply." });
  })
);

// GET /api/users/:id/public — lightweight public shape (kept for future clients)
router.get("/:id/public", (req, res) =>
  tryCatch(res, async () => {
    const user = await get("SELECT * FROM users WHERE id=?", [req.params.id]);
    if (!user) return res.status(404).json({ success: false, message: "User not found." });
    res.json({ success: true, user: publicUser(user) });
  })
);

export default router;
