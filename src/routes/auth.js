// ==================== BloodOra Backend API - Auth ====================
import express from "express";
import bcrypt from "bcryptjs";
import { get, run } from "../db.js";
import { signToken, genSessionToken, requireAuth } from "../auth.js";
import { upload } from "../upload.js";
import { getClientIp, getDeviceFingerprint, calculateAge, normalizeUser, tryCatch } from "../utils.js";

const router = express.Router();

// POST /api/auth/register  (multipart/form-data, optional field: profile_pic)
router.post("/register", upload.single("profile_pic"), (req, res) =>
  tryCatch(res, async () => {
    const { name, email, phone, password, blood_group, role, division, district, upazila, union, holding, birth_certificate, date_of_birth } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ success: false, message: "❌ Please fill required fields (name, email, password)." });
    }
    const existing = await get("SELECT id FROM users WHERE email = ?", [email]);
    if (existing) {
      return res.status(409).json({ success: false, message: "⚠️ Email already registered." });
    }
    let filename = "default.jpg";
    if (req.file) filename = req.file.filename;

    const countRow = await get("SELECT COUNT(*) as c FROM users");
    const isFirstUser = countRow.c === 0;

    let age = null, dob = null;
    if (date_of_birth) {
      dob = date_of_birth;
      age = calculateAge(date_of_birth);
    }
    if (!age && req.body.age) age = parseInt(req.body.age);

    const is_verified = age && age >= 18 ? 1 : 0;
    const can_donate = age && age >= 18 ? 1 : 0;

    const hash = await bcrypt.hash(password, 10);
    const token = genSessionToken();
    const ip = getClientIp(req);
    const device = getDeviceFingerprint(req);
    const now = new Date().toISOString();

    await run(
      `INSERT INTO users (name,email,phone,division,district,upazila,union_area,address_holding,blood_group,image_file,password_hash,role,age,date_of_birth,birth_certificate_number,is_verified,can_donate,is_admin,is_super_admin,session_token,last_login_ip,last_login_device,last_login_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        name, email, phone || "", division ?? null, district ?? null, upazila ?? null,
        union ?? null, holding ?? null, blood_group ?? null, filename, hash, role || "Both",
        age ?? null, dob ?? null, birth_certificate ?? null, is_verified, can_donate,
        isFirstUser ? 1 : 0, isFirstUser ? 1 : 0, token, ip, device, now,
      ]
    );

    const user = await get("SELECT * FROM users WHERE email = ?", [email]);
    const jwtToken = signToken(user);
    const { password_hash, ...safeUser } = normalizeUser(user);
    res.json({
      success: true,
      token: jwtToken,
      user: safeUser,
      message: is_verified
        ? "✅ Registration successful! You are verified as a donor (18+)."
        : "✅ Registration successful! You will be verified when you turn 18.",
    });
  })
);

// POST /api/auth/login  (JSON: { email, password })
router.post("/login", (req, res) =>
  tryCatch(res, async () => {
    const { email, password } = req.body || {};
    const user = await get("SELECT * FROM users WHERE email = ?", [email]);
    if (!user || !(await bcrypt.compare(password || "", user.password_hash))) {
      return res.status(401).json({ success: false, message: "❌ Invalid email or password." });
    }
    const token = genSessionToken();
    const ip = getClientIp(req);
    const device = getDeviceFingerprint(req);
    const now = new Date().toISOString();
    await run("UPDATE users SET session_token=?, last_login_ip=?, last_login_device=?, last_login_at=? WHERE id=?", [token, ip, device, now, user.id]);
    user.session_token = token;
    const { password_hash, ...safeUser } = normalizeUser(user);
    res.json({
      success: true,
      token: signToken(user),
      user: safeUser,
      message: `👋 Welcome back, ${user.name}!`,
    });
  })
);

// POST /api/auth/logout — rotates session token, invalidating the JWT everywhere
router.post("/logout", requireAuth, (req, res) =>
  tryCatch(res, async () => {
    await run("UPDATE users SET session_token=? WHERE id=?", [genSessionToken(), req.user.id]);
    res.json({ success: true, message: "✅ Logged out." });
  })
);

// GET /api/auth/me — current user for the presented token
router.get("/me", requireAuth, (req, res) => {
  // Strip sensitive fields for the frontend session cache
  const { password_hash, ...safe } = req.user;
  res.json({ success: true, user: safe });
});

export default router;
