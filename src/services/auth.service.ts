import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { userRepo } from "../repos/user.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { config } from "../config/env.js";
import { ApiError, randomId, maskEmail } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { Role, SafeUser, UserRow } from "../types.js";

const BCRYPT_ROUNDS = 10;
const SESSION_COOKIE = "bloodora_session";
const SESSION_JWT_CLAIM = "jwt";

export interface LoginResult {
  user: SafeUser;
  token: string;
}

export interface RegisterInput {
  name: string;
  email: string;
  phone: string;
  password: string;
  bloodGroup?: string | null;
  city?: string | null;
  donationRole?: string | null;
  addressHolding?: string | null;
  division?: string | null;
  district?: string | null;
  upazila?: string | null;
  unionArea?: string | null;
  age?: number | null;
  dateOfBirth?: string | null;
  birthCertificate?: string | null;
  imageFile?: string | null;
}

function toSafeUser(row: UserRow): SafeUser {
  const { password_hash: _p, session_token: _s, ...safe } = row;
  // The original API normalized 0/1 flags to booleans — views rely on that.
  return {
    ...safe,
    is_admin: Boolean(safe.is_admin),
    is_super_admin: Boolean(safe.is_super_admin),
    is_verified: Boolean(safe.is_verified),
    can_donate: Boolean(safe.can_donate),
  } as unknown as SafeUser;
}

function signToken(user: UserRow): string {
  return jwt.sign(
    { uid: user.id, sid: user.session_token, adm: user.role !== "user" },
    config.jwtSecret,
    { expiresIn: `${config.jwtTtlDays}d` },
  );
}

/**
 * Verify a bearer token. The payload must still match the user's current
 * session_token, so logout (token rotation) revokes every issued JWT instantly.
 */
export function verifyToken(token: string): { userId: string; admin: boolean } {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  } catch {
    throw ApiError.unauthorized("Session expired or invalid", "SESSION_INVALID");
  }
  if (typeof payload !== "object" || !payload.uid || !payload.sid) {
    throw ApiError.unauthorized("Session expired or invalid", "SESSION_INVALID");
  }
  return { userId: String(payload.uid), admin: Boolean(payload.adm) };
}

export async function loginUser(row: UserRow): Promise<LoginResult> {
  const token = randomId(24);
  await userRepo.setSessionToken(row.id, token);
  const fresh = (await userRepo.findById(row.id))!;
  const jwtToken = signToken(fresh);
  logger.info("auth: login", { user: maskEmail(row.email), role: row.role });
  return { user: toSafeUser(fresh), token: jwtToken };
}

export const authService = {
  async register(input: RegisterInput): Promise<LoginResult> {
    const existing = await userRepo.findByEmail(input.email);
    if (existing) throw ApiError.conflict("An account with this email already exists", "EMAIL_TAKEN");

    const totalUsers = await userRepo.count();
    const firstUser = totalUsers === 0;
    // Original register: 18+ users are auto-verified and may donate.
    const adult = Boolean(input.age && input.age >= 18);

    const user: Omit<UserRow, "created_at"> = {
      id: randomId(),
      name: input.name,
      email: input.email.toLowerCase(),
      phone: input.phone,
      password_hash: await bcrypt.hash(input.password, BCRYPT_ROUNDS),
      is_admin: firstUser ? 1 : 0,
      is_super_admin: firstUser ? 1 : 0,
      role: firstUser ? "super_admin" : "user",
      donation_role: input.donationRole ?? "Both",
      blood_group: input.bloodGroup ?? null,
      city: input.city ?? null,
      address_holding: input.addressHolding ?? null,
      division: input.division ?? null,
      district: input.district ?? null,
      upazila: input.upazila ?? null,
      union_area: input.unionArea ?? null,
      can_donate: adult ? 1 : 0,
      last_donation: null,
      age: input.age ?? null,
      date_of_birth: input.dateOfBirth ?? null,
      birth_certificate_number: input.birthCertificate ?? null,
      bkash_number: null,
      nagad_number: null,
      upay_number: null,
      rocket_number: null,
      pathao_number: null,
      card_last_four: null,
      card_type: null,
      is_verified: adult ? 1 : 0,
      image_file: input.imageFile ?? null,
      session_token: null,
    };

    try {
      await userRepo.create(user);
    } catch (err) {
      const e = err as { code?: number; message?: string };
      if (e.code === 1901 || /UNIQUE/i.test(e.message || "")) {
        throw ApiError.conflict("An account with this email already exists", "EMAIL_TAKEN");
      }
      throw err;
    }

    await activityRepo.create(
      "register",
      user.id,
      firstUser ? "The first account was created — it is now the super admin" : `${user.name} joined BloodOra`,
      { email: maskEmail(user.email) },
    );
    logger.info("auth: registered", { user: maskEmail(user.email), firstUser });

    const created = (await userRepo.findById(user.id))!;
    return loginUser(created);
  },

  async login(email: string, password: string): Promise<LoginResult> {
    const row = await userRepo.findByEmail(email);
    if (!row) throw ApiError.unauthorized("Invalid email or password", "BAD_CREDENTIALS");
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) throw ApiError.unauthorized("Invalid email or password", "BAD_CREDENTIALS");
    return loginUser(row);
  },

  /** Resolve a user id from the session cookie handle or a bearer token. */
  async resolveUser(reqUser: { session?: Record<string, unknown> | null } | undefined, bearer?: string): Promise<SafeUser | null> {
    const raw = bearer || (reqUser?.session?.[SESSION_JWT_CLAIM] as string | undefined);
    const token = typeof raw === "string" ? raw : undefined;
    if (!token) return null;
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    } catch {
      return null;
    }
    if (typeof payload !== "object" || !payload.uid || !payload.sid) return null;
    const row = await userRepo.findById(String(payload.uid));
    if (!row) return null;
    if (row.session_token !== payload.sid) return null; // logged out elsewhere
    return toSafeUser(row);
  },

  async me(userId: string): Promise<SafeUser> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.unauthorized("Account no longer exists", "USER_GONE");
    return toSafeUser(row);
  },

  async logout(userId: string): Promise<void> {
    await userRepo.setSessionToken(userId, null);
    await activityRepo.create("logout", userId, "An account signed out");
    logger.info("auth: logout", { user: userId });
  },

  /** Re-verify an admin claim for the current request (token still live). */
  async requireAdmin(userId: string, isAdminClaim: boolean): Promise<SafeUser> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.unauthorized("Account no longer exists", "USER_GONE");
    if (!isAdminClaim || row.role === "user") {
      throw ApiError.forbidden("Admin access required", "ADMIN_ONLY");
    }
    return toSafeUser(row);
  },

  async requireSuperAdmin(userId: string): Promise<SafeUser> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.unauthorized("Account no longer exists", "USER_GONE");
    if (row.role !== "super_admin") {
      throw ApiError.forbidden("Super admin access required", "SUPER_ADMIN_ONLY");
    }
    return toSafeUser(row);
  },

  /** Impersonate: switch the caller's JWT context to another user (admin only). */
  async impersonate(actorId: string, targetId: string): Promise<{ token: string; user: SafeUser }> {
    const actor = await userRepo.findById(actorId);
    if (!actor || actor.role === "user") throw ApiError.forbidden("Admin access required", "ADMIN_ONLY");
    const target = await userRepo.findById(targetId);
    if (!target) throw ApiError.notFound("User not found", "USER_NOT_FOUND");
    await activityRepo.create("impersonate", actorId, `${actor.name} started impersonating ${target.name}`, { target: targetId });
    // A fresh token bound to the target's session token keeps revocation intact;
    // the imp_by claim records the real admin so "switch back" can restore it.
    const fresh = (await userRepo.findById(targetId))!;
    const token = jwt.sign(
      { uid: fresh.id, sid: fresh.session_token, adm: fresh.role !== "user", imp_by: actorId },
      config.jwtSecret,
      { expiresIn: `${config.jwtTtlDays}d` },
    );
    return { token, user: toSafeUser(fresh) };
  },

  /** Stop impersonating: return a token for the original admin. */
  async switchBack(adminId: string): Promise<{ token: string; user: SafeUser }> {
    const row = await userRepo.findById(adminId);
    if (!row) throw ApiError.unauthorized("Account no longer exists", "USER_GONE");
    if (row.role === "user") throw ApiError.forbidden("Admin access required", "ADMIN_ONLY");
    const fresh = (await userRepo.findById(adminId))!;
    return { token: signToken(fresh), user: toSafeUser(fresh) };
  },
};

export type { Role };
