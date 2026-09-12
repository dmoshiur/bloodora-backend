// ==================== BloodOra Backend - Shared Utilities ====================

export function calculateAge(dob) {
  if (!dob) return null;
  const today = new Date();
  const birth = new Date(dob);
  if (isNaN(birth.getTime())) return null;
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

export function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.ip || (req.socket && req.socket.remoteAddress) || "127.0.0.1";
}

export function getDeviceFingerprint(req) {
  const ua = req.headers["user-agent"] || "";
  let hash = 0;
  for (let i = 0; i < ua.length; i++) hash = ((hash << 5) - hash + ua.charCodeAt(i)) & 0xffffffff;
  return Math.abs(hash).toString(16).padStart(16, "0").slice(0, 16);
}

// Normalize sqlite 0/1 flags to booleans for API consumers
export function normalizeUser(u) {
  if (!u) return u;
  return {
    ...u,
    is_admin: !!u.is_admin,
    is_super_admin: !!u.is_super_admin,
    is_verified: !!u.is_verified,
    can_donate: !!u.can_donate,
  };
}

// Public-safe user shape (never leak password hash / payment numbers to strangers)
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    phone: u.phone,
    division: u.division,
    district: u.district,
    upazila: u.upazila,
    union_area: u.union_area,
    address_holding: u.address_holding,
    blood_group: u.blood_group,
    image_file: u.image_file,
    role: u.role,
    age: u.age,
    can_donate: !!u.can_donate,
    is_verified: !!u.is_verified,
    is_admin: !!u.is_admin,
    is_super_admin: !!u.is_super_admin,
    last_donation: u.last_donation,
    created_at: u.created_at,
  };
}

export async function tryCatch(res, fn) {
  try {
    return await fn();
  } catch (e) {
    console.error("API error:", e);
    return res.status(500).json({ success: false, message: "❌ Server error: " + (e.message || e) });
  }
}
