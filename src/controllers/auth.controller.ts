import type { Request, Response } from "express";
import { z } from "zod";
import { parse, str } from "../utils/validate.js";
import { ApiError } from "../utils/errors.js";
import { authService } from "../services/auth.service.js";
import { userService } from "../services/user.service.js";
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

export async function login(req: Request, res: Response): Promise<void> {
  const body = parse(loginSchema, req.body);
  const result = await authService.login(body.email, body.password);
  if (req.session) req.session.jwt = result.token;
  res.json({ user: result.user, token: result.token });
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

export async function me(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const user = await authService.me(req.user.id);
  res.json({ user });
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
