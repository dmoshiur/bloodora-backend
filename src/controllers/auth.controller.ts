import type { Request, Response } from "express";
import { z } from "zod";
import { parse, str } from "../utils/validate.js";
import { ApiError } from "../utils/errors.js";
import { authService, type AuthCtx } from "../services/auth.service.js";
import { rbacService } from "../services/rbac.service.js";
import { userService } from "../services/user.service.js";
import { resetSharedLimit } from "../middleware/rateLimit.js";
import { langOf } from "../middleware/language.js";
import { uploadService } from "../services/upload.service.js";
import { readUpload } from "../uploads/uploads.js";
import { singleUpload } from "../uploads/uploads.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";

const optionalText = z
  .union([z.string(), z.number(), z.literal("")])
  .optional()
  .transform((v) => (v == null || v === "" ? null : String(v).trim()));

const registerSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    email: z.string().trim().email().max(160),
    phone: z.string().trim().min(6).max(24),
    password: z.string().min(8).max(128),
    blood_group: optionalText,
    city: optionalText,
    // original register form fields (donation role + location + identity)
    role: optionalText,
    division: optionalText,
    district: optionalText,
    upazila: optionalText,
    union: optionalText,
    holding: optionalText,
    birth_certificate: optionalText,
    date_of_birth: optionalText,
    age: optionalText,
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().trim().email(),
    password: z.string().min(1).max(128),
  })
  .strict();

const forgotSchema = z
  .object({
    email: z.string().trim().email().max(160),
  })
  .strict();

const resetSchema = z
  .object({
    // Accept the common aliases so a client can post whichever name it used to
    // store the link parameter; the service only ever sees `token`.
    token: z.string().trim().min(8).max(200).optional(),
    t: z.string().trim().min(8).max(200).optional(),
    // Length is NOT checked here: `assertPasswordPolicy` owns the rule so that
    // register / change / reset cannot drift apart, and so the client gets the
    // localized PASSWORD_SHORT message instead of a generic schema error.
    password: z.string().max(128).optional(),
    new_password: z.string().max(128).optional(),
  })
  .strict();

const tokenSchema = z
  .object({
    token: z.string().trim().min(8).max(200).optional(),
    t: z.string().trim().min(8).max(200).optional(),
  })
  .strict();

const profileSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    email: z.string().trim().email().max(160).optional(),
    phone: z.string().trim().min(6).max(24).optional(),
    blood_group: z.string().trim().max(3).nullable().optional(),
    city: z.string().trim().max(80).nullable().optional(),
  })
  .strict();

const passwordSchema = z
  .object({
    current: z.string().min(1).max(128),
    next: z.string().min(8).max(128),
  })
  .strict();

/** Original utils.calculateAge — age from a date-of-birth string, or null. */
function calculateAge(dob: string | null): number | null {
  if (!dob) return null;
  const birth = new Date(dob);
  if (isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

export async function register(req: Request, res: Response): Promise<void> {
  const body = parse(registerSchema, req.body);
  // multipart: optional profile_pic uploaded via the frontend form.
  const file = readUpload(req);
  const imageFile = file ? await uploadService.store(file) : null;
  // Original register: age comes from date_of_birth when present, else the
  // explicit `age` field; 18+ users are auto-verified and can donate.
  const dob = body.date_of_birth ?? null;
  let age: number | null = dob ? calculateAge(dob) : null;
  if (!age && body.age) {
    const parsed = parseInt(body.age, 10);
    if (!Number.isNaN(parsed)) age = parsed;
  }
  const result = await authService.register({
    name: body.name,
    email: body.email,
    phone: body.phone,
    password: body.password,
    bloodGroup: body.blood_group,
    city: body.city,
    donationRole: body.role ?? "Both",
    addressHolding: body.holding,
    division: body.division,
    district: body.district,
    upazila: body.upazila,
    unionArea: body.union,
    age: age && age > 0 ? age : null,
    dateOfBirth: dob,
    birthCertificate: body.birth_certificate,
    imageFile,
  });
  // Keep the JWT in the persistent (Turso-backed) session too, so cookie-based
  // browsers work across instances and cold starts.
  if (req.session) req.session.jwt = result.token;
  res.status(201).json({
    user: result.user,
    token: result.token,
    message: result.user.is_verified
      ? "✅ Registration successful! You are verified as a donor (18+)."
      : "✅ Registration successful! You will be verified when you turn 18.",
  });
}

/** Caller context for audited auth operations (IP behind a proxy, language). */
function authCtx(req: Request): AuthCtx {
  const xff = req.headers["x-forwarded-for"];
  const ip = typeof xff === "string" && xff.trim() ? xff.split(",")[0].trim() : req.ip || null;
  return { ip, userAgent: str(req.headers["user-agent"]) ?? null, lang: langOf(req) };
}

export async function login(req: Request, res: Response): Promise<void> {
  const body = parse(loginSchema, req.body);
  const result = await authService.login(body.email, body.password, authCtx(req));
  if (req.session) req.session.jwt = result.token;
  // A correct password should not inherit the failures that preceded it: clear
  // the shared (cross-instance) counter for this IP + email bucket.
  await resetSharedLimit("login", req, body.email);
  res.json({ user: result.user, token: result.token });
}

// --------------------- password reset & email verification ---------------------

/**
 * POST /api/auth/forgot-password — {email}.
 *
 * Always answers 200 with the same message (see authService.requestPasswordReset):
 * the response must not reveal whether the address exists.
 */
export async function forgotPassword(req: Request, res: Response): Promise<void> {
  const body = parse(forgotSchema, req.body);
  const out = await authService.requestPasswordReset(body.email, authCtx(req));
  res.json({ success: true, ...out });
}

/** GET /api/auth/reset-password/validate?token=… — is the link still usable? */
export async function validateReset(req: Request, res: Response): Promise<void> {
  const token = str(req.query.token) ?? str(req.query.t);
  const out = await authService.validateResetToken(token ?? "");
  res.json({ success: true, ...out });
}

/** POST /api/auth/reset-password — {token, password}. */
export async function resetPassword(req: Request, res: Response): Promise<void> {
  const body = parse(resetSchema, req.body);
  const token = body.token ?? body.t;
  const password = body.password ?? body.new_password;
  if (!token) throw ApiError.badRequest("A reset token is required.", "RESET_TOKEN_REQUIRED");
  if (!password) throw ApiError.badRequest("A new password is required.", "PASSWORD_REQUIRED");
  const out = await authService.resetPassword(token, password, authCtx(req));
  // The reset rotated the session token, so any session on this request is dead.
  res.clearCookie("connect.sid", { httpOnly: true, sameSite: "lax", secure: config.cookieSecure });
  res.json({ success: true, ...out });
}

/** POST /api/auth/verify-email/request — (re)send the verification link. */
export async function requestVerification(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const out = await authService.requestEmailVerification(req.user, authCtx(req));
  res.json({ success: true, ...out });
}

/** POST /api/auth/verify-email — {token}. */
export async function verifyEmail(req: Request, res: Response): Promise<void> {
  const body = parse(tokenSchema, req.body ?? {});
  const token = body.token ?? body.t ?? str(req.query.token);
  if (!token) throw ApiError.badRequest("A verification token is required.", "VERIFY_TOKEN_REQUIRED");
  const out = await authService.confirmEmail(token, authCtx(req));
  res.json({ success: true, ...out });
}

export async function logout(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  // Revoke on the DB side first: users.session_token = null invalidates the
  // bearer JWT immediately (every request re-checks the sid claim).
  await authService.logout(req.user.id);
  // Clear the cookie BEFORE sending the response. session.destroy() is
  // async (persistent store), so clearing inside its callback would run
  // after res.json() → ERR_HTTP_HEADERS_SENT (crash vector).
  res.clearCookie("connect.sid", { httpOnly: true, sameSite: "lax", secure: config.cookieSecure });
  res.json({ ok: true });
  // Now drop the persistent session row (fire-and-forget; already logged out).
  if (req.session) {
    req.session.destroy((err) => {
      if (err) logger.warn("session: destroy failed after logout", { err: String(err) });
    });
  }
}

/**
 * GET /api/auth/me — the caller's account plus what it may do.
 *
 * `user` keeps its exact original shape (`user.role` is the account role and the
 * admin dashboard separately reports the donation role). `account_role` and
 * `permissions` are ADDED so a client can hide UI it is not allowed to use
 * instead of guessing from `is_admin`.
 */
export async function me(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const user = await authService.me(req.user.id);
  let permissions: string[] = [];
  let accountRole = user.role ?? "user";
  try {
    const eff = await rbacService.effective(user);
    permissions = eff.permissions;
    accountRole = eff.role;
  } catch (err) {
    // Capabilities are additive UI metadata: a roles-table problem must not turn
    // "who am I?" into a 500.
    logger.warn("auth: could not resolve permissions for /me", { err: String((err as Error)?.message ?? err) });
  }
  res.json({ user, account_role: accountRole, permissions });
}

export async function updateProfile(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const body = parse(profileSchema, req.body);
  const user = await userService.updateProfile(req.user.id, body as unknown as Record<string, unknown>);
  res.json({ user });
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const body = parse(passwordSchema, req.body);
  await userService.changePassword(req.user.id, body.current, body.next);
  res.json({ ok: true });
}

export const uploadProfileImage = singleUpload("image");

export async function setProfileImage(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const file = readUpload(req);
  if (!file) throw ApiError.badRequest("No image uploaded (field name: image)", "NO_IMAGE");
  const filename = await uploadService.store(file);
  const user = await userService.setProfileImage(req.user.id, filename);
  res.json({ user, image: `/uploads/${filename}` });
}
