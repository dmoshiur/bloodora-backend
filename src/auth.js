// ==================== BloodOra Backend - JWT Auth ====================
// Stateless JWT auth so the frontend (hosted on a different Vercel
// project/account) can call this API from its own server or the browser.
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { get } from "./db.js";
import { normalizeUser } from "./utils.js";

export const JWT_SECRET =
  process.env.JWT_SECRET || process.env.SESSION_SECRET || "bloodora-dev-jwt-secret-change-me";
export const TOKEN_TTL = "7d";

export function genSessionToken() {
  return uuidv4();
}

// Sign a JWT bound to the user's current DB session_token (single-session enforcement)
export function signToken(user) {
  return jwt.sign(
    { uid: user.id, sid: user.session_token || null, adm: user.is_admin ? 1 : 0 },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function extractToken(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  // Allow ?token= for special cases (e.g. downloads) - Bearer preferred
  if (req.query && req.query.token) return String(req.query.token);
  return null;
}

async function resolveUser(req) {
  const token = extractToken(req);
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null; // expired / invalid
  }
  const user = await get("SELECT * FROM users WHERE id = ?", [payload.uid]);
  if (!user) return null;
  // Single-session enforcement: token must match current DB session_token
  if (user.session_token && payload.sid !== user.session_token) return null;
  return normalizeUser(user);
}

// Attaches req.user when a valid token is present; does nothing otherwise.
export function optionalAuth(req, res, next) {
  resolveUser(req)
    .then((user) => {
      if (user) req.user = user;
      next();
    })
    .catch(() => next());
}

export function requireAuth(req, res, next) {
  resolveUser(req)
    .then((user) => {
      if (!user) return res.status(401).json({ success: false, message: "⚠️ Please login to continue." });
      req.user = user;
      next();
    })
    .catch(() => res.status(401).json({ success: false, message: "⚠️ Please login to continue." }));
}

export function requireAdmin(req, res, next) {
  resolveUser(req)
    .then((user) => {
      if (!user) return res.status(401).json({ success: false, message: "⚠️ Please login to continue." });
      if (!user.is_admin) return res.status(403).json({ success: false, message: "❌ Admin access required." });
      req.user = user;
      next();
    })
    .catch(() => res.status(401).json({ success: false, message: "⚠️ Please login to continue." }));
}

export function requireSuperAdmin(req, res, next) {
  resolveUser(req)
    .then((user) => {
      if (!user) return res.status(401).json({ success: false, message: "⚠️ Please login to continue." });
      if (!user.is_admin) return res.status(403).json({ success: false, message: "❌ Admin access required." });
      if (!user.is_super_admin) return res.status(403).json({ success: false, message: "❌ Super Admin access required." });
      req.user = user;
      next();
    })
    .catch(() => res.status(401).json({ success: false, message: "⚠️ Please login to continue." }));
}
