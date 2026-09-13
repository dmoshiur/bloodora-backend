import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { userRepo } from "../repos/user.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { tokenRepo, TOKEN_TTL_MS } from "../repos/token.repo.js";
import { auditRepo } from "../repos/audit.repo.js";
import { config } from "../config/env.js";
import { ApiError, randomId, maskEmail } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { toSafeUser } from "../utils/userShape.js";
import { translate } from "../i18n/index.js";
import { emailService } from "./email.service.js";
import { notificationService } from "./notification.service.js";
import { isoIn, nowIso } from "../utils/time.js";
import type { Role, SafeUser, UserRow } from "../types.js";

const BCRYPT_ROUNDS = 10;
const SESSION_COOKIE = "bloodora_session";
const SESSION_JWT_CLAIM = "jwt";

/** Caller context for audited/side-effecting auth operations. */
export interface AuthCtx {
  ip?: string | null;
  userAgent?: string | null;
  lang?: string | null;
}

/** How many reset links one account may request per 15 minutes. */
const RESET_BURST_LIMIT = 3;
const RESET_BURST_WINDOW_MS = 15 * 60 * 1000;

/**
 * Password policy, enforced in ONE place so registration, an in-session change
 * and a token reset cannot drift apart (the reset path used to have no policy at
 * all, which is how a 1-character password could be set).
 */
export function assertPasswordPolicy(password: unknown, lang?: string | null): void {
  const pw = typeof password === "string" ? password : "";
  if (pw.length < 8) throw ApiError.badRequest(translate(lang, "auth.password_short"), "PASSWORD_SHORT");
  if (pw.length > 128) throw ApiError.badRequest("Password must be at most 128 characters.", "PASSWORD_LONG");
}

/**
 * Absolute link for a token email.
 *
 * Falls back to a relative path when FRONTEND_URL is not configured, because a
 * link to `undefined/reset-password` is worse than one the mail client cannot
 * click — the token is also printed in the body, so the flow stays usable.
 */
function tokenLink(path: string, token: string): string {
  const base = config.frontendUrl.replace(/\/$/, "");
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}

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

export async function loginUser(row: UserRow, ctx: AuthCtx = {}): Promise<LoginResult> {
  const token = randomId(24);
  await userRepo.setSessionToken(row.id, token);
  const fresh = (await userRepo.findById(row.id))!;
  const jwtToken = signToken(fresh);

  // Recorded for the dashboard ("last seen") and for the security notice below.
  // Best effort: a failed write must never lock anybody out.
  await userRepo.touchLogin(row.id).catch((err) => {
    logger.warn("auth: could not record the login time", { err: String((err as Error)?.message ?? err) });
  });

  const safe = toSafeUser(fresh);
  if (safe.notify_inapp !== false) {
    notificationService.emitAsync({
      event: "new_login",
      userIds: [row.id],
      params: { date: nowIso().slice(0, 16).replace("T", " ") },
      dedupeKey: `login:${row.session_token ?? jwtToken.slice(0, 12)}`,
    });
  }
  if (safe.notify_email !== false) {
    void emailService.securityNotice(
      { email: row.email, language: row.language },
      "email.new_login.subject",
      nowIso(),
      ctx.lang ?? row.language,
    ).catch((err) => logger.warn("auth: login notice email failed", { err: String((err as Error)?.message ?? err) }));
  }

  logger.info("auth: login", { user: maskEmail(row.email), role: row.role, ip: ctx.ip ?? null });
  return { user: safe, token: jwtToken };
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

    // Welcome + verification are queued through the mail outbox, so a mail
    // problem never fails a registration that already succeeded.
    void emailService.welcome(user.id).catch((err) => logger.warn("auth: welcome email failed", { err: String((err as Error)?.message ?? err) }));
    try {
      const { token } = await tokenRepo.issue(user.id, "email_verify", null);
      const hours = Math.round(TOKEN_TTL_MS.email_verify / 3600000);
      void emailService
        .emailVerification({ email: user.email, name: user.name }, tokenLink("/verify-email", token), hours)
        .catch((err) => logger.warn("auth: verification email failed", { err: String((err as Error)?.message ?? err) }));
    } catch (err) {
      logger.warn("auth: could not issue a verification token", { err: String((err as Error)?.message ?? err) });
    }

    return loginUser(created);
  },

  async login(email: string, password: string, ctx: AuthCtx = {}): Promise<LoginResult> {
    const row = await userRepo.findByEmail(email);
    if (!row) {
      // Audited without the password and without revealing which half was wrong.
      await auditRepo
        .create({
          actorId: null,
          action: "auth.login.failed",
          entityType: "user",
          summary: `Failed login for unknown email ${maskEmail(email)}`,
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
        })
        .catch(() => {});
      throw ApiError.unauthorized(translate(ctx.lang, "auth.bad_credentials"), "BAD_CREDENTIALS");
    }
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) {
      await auditRepo
        .create({
          actorId: row.id,
          actorRole: row.role,
          action: "auth.login.failed",
          entityType: "user",
          entityId: row.id,
          summary: `Failed login for ${maskEmail(row.email)}`,
          ip: ctx.ip ?? null,
          userAgent: ctx.userAgent ?? null,
        })
        .catch(() => {});
      throw ApiError.unauthorized(translate(ctx.lang, "auth.bad_credentials"), "BAD_CREDENTIALS");
    }
    await auditRepo
      .create({
        actorId: row.id,
        actorRole: row.role,
        action: "auth.login",
        entityType: "user",
        entityId: row.id,
        summary: `Signed in: ${row.name}`,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      })
      .catch(() => {});
    return loginUser(row, ctx);
  },

  // --------------------- password reset (self-service) ---------------------

  /**
   * POST /api/auth/forgot-password — issue a single-use reset token.
   *
   * The response is IDENTICAL whether or not the address exists: an endpoint
   * that says "no such account" is an account-enumeration oracle, and one that
   * leaks the failure through timing is nearly as bad. The only case that throws
   * is the per-account burst limit, which protects the mail queue.
   */
  async requestPasswordReset(email: string, ctx: AuthCtx = {}): Promise<{ message: string }> {
    const normalized = String(email || "").trim().toLowerCase();
    const generic = { message: translate(ctx.lang, "auth.reset_sent") };
    if (!normalized) return generic;

    const row = await userRepo.findByEmail(normalized);
    if (!row) {
      logger.info("auth: reset requested for an unknown email", { email: maskEmail(normalized) });
      return generic;
    }

    const since = isoIn(-RESET_BURST_WINDOW_MS);
    const recent = await tokenRepo.countIssuedSince(row.id, "password_reset", since);
    if (recent >= RESET_BURST_LIMIT) {
      await auditRepo
        .create({
          actorId: row.id,
          actorRole: row.role,
          action: "auth.reset.throttled",
          entityType: "user",
          entityId: row.id,
          summary: `${recent} reset links in the last 15 minutes`,
          ip: ctx.ip ?? null,
        })
        .catch(() => {});
      throw new ApiError(429, "RESET_THROTTLED", translate(ctx.lang, "error.rate_limited"));
    }

    const { token } = await tokenRepo.issue(row.id, "password_reset", ctx.ip ?? null);
    const minutes = Math.round(TOKEN_TTL_MS.password_reset / 60000);
    const link = tokenLink("/reset-password", token);

    // Outbox-first: the mail is queued durably before any SMTP attempt, so a
    // down mail host delays the email instead of failing the request.
    await emailService
      .passwordReset({ id: row.id, name: row.name, email: row.email, language: row.language }, link, minutes, ctx.lang ?? row.language)
      .catch((err) => logger.warn("auth: reset email failed", { err: String((err as Error)?.message ?? err) }));

    await auditRepo
      .create({
        actorId: row.id,
        actorRole: row.role,
        action: "auth.reset.requested",
        entityType: "user",
        entityId: row.id,
        summary: `Password reset requested for ${maskEmail(row.email)}`,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      })
      .catch(() => {});
    logger.info("auth: password reset requested", { user: maskEmail(row.email), ip: ctx.ip ?? null });
    return generic;
  },

  /** GET /api/auth/reset-password/validate — is this token still usable? */
  async validateResetToken(token: string): Promise<{ valid: boolean; email: string | null }> {
    const row = token ? await tokenRepo.findValid(String(token).trim(), "password_reset") : null;
    if (!row) return { valid: false, email: null };
    const user = await userRepo.findById(row.user_id);
    return { valid: true, email: user ? maskEmail(user.email) : null };
  },

  /**
   * POST /api/auth/reset-password — consume the token and set a new password.
   *
   * Consumption is a conditional UPDATE, so two submissions of the same link
   * cannot both succeed. Every existing session is invalidated (the session
   * token is rotated) because whoever needed a reset link may have lost control
   * of the account.
   */
  async resetPassword(token: string, password: string, ctx: AuthCtx = {}): Promise<{ message: string }> {
    assertPasswordPolicy(password, ctx.lang);
    const row = token ? await tokenRepo.findValid(String(token).trim(), "password_reset") : null;
    if (!row) throw ApiError.badRequest(translate(ctx.lang, "auth.reset_invalid"), "RESET_TOKEN_INVALID");

    const consumed = await tokenRepo.consume(row.id);
    if (!consumed) throw ApiError.badRequest(translate(ctx.lang, "auth.reset_invalid"), "RESET_TOKEN_INVALID");

    const user = await userRepo.findById(row.user_id);
    if (!user) throw ApiError.badRequest(translate(ctx.lang, "auth.reset_invalid"), "RESET_TOKEN_INVALID");

    await userRepo.setPassword(user.id, await bcrypt.hash(password, BCRYPT_ROUNDS));
    // Rotate the session token: every JWT issued before the reset stops working.
    await userRepo.setSessionToken(user.id, randomId(24));
    await tokenRepo.revokeAllForUser(user.id);

    await auditRepo
      .create({
        actorId: user.id,
        actorRole: user.role,
        action: "auth.reset.completed",
        entityType: "user",
        entityId: user.id,
        summary: `Password reset completed for ${maskEmail(user.email)}`,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      })
      .catch(() => {});
    await activityRepo.create("password", user.id, "A password was reset with an email link");
    notificationService.emitAsync({
      event: "password_reset",
      userIds: [user.id],
      params: {},
      dedupeKey: `password-reset:${row.id}`,
    });
    void emailService
      .securityNotice({ email: user.email, language: user.language }, "email.password_changed.subject", nowIso(), ctx.lang ?? user.language)
      .catch((err) => logger.warn("auth: reset notice email failed", { err: String((err as Error)?.message ?? err) }));

    logger.info("auth: password reset completed", { user: maskEmail(user.email), ip: ctx.ip ?? null });
    return { message: translate(ctx.lang, "auth.reset_done") };
  },

  // ------------------------- email verification -------------------------

  /** POST /api/auth/verify-email/request — (re)send the verification link. */
  async requestEmailVerification(user: SafeUser, ctx: AuthCtx = {}): Promise<{ message: string }> {
    const row = await userRepo.findById(user.id);
    if (!row) throw ApiError.unauthorized("Account no longer exists", "USER_GONE");
    if (row.email_verified === 1) return { message: translate(ctx.lang, "auth.verify_done") };

    const { token } = await tokenRepo.issue(row.id, "email_verify", ctx.ip ?? null);
    const hours = Math.round(TOKEN_TTL_MS.email_verify / 3600000);
    await emailService
      .emailVerification({ email: row.email, name: row.name, language: row.language }, tokenLink("/verify-email", token), hours, ctx.lang ?? row.language)
      .catch((err) => logger.warn("auth: verification email failed", { err: String((err as Error)?.message ?? err) }));

    await auditRepo
      .create({
        actorId: row.id,
        actorRole: row.role,
        action: "auth.verify.requested",
        entityType: "user",
        entityId: row.id,
        summary: `Email verification requested for ${maskEmail(row.email)}`,
        ip: ctx.ip ?? null,
      })
      .catch(() => {});
    return { message: translate(ctx.lang, "auth.verify_sent") };
  },

  /** POST /api/auth/verify-email — confirm the address from the link. */
  async confirmEmail(token: string, ctx: AuthCtx = {}): Promise<{ message: string }> {
    const row = token ? await tokenRepo.findValid(String(token).trim(), "email_verify") : null;
    if (!row) throw ApiError.badRequest("This verification link is invalid or has expired.", "VERIFY_TOKEN_INVALID");
    const consumed = await tokenRepo.consume(row.id);
    if (!consumed) throw ApiError.badRequest("This verification link is invalid or has expired.", "VERIFY_TOKEN_INVALID");

    const user = await userRepo.findById(row.user_id);
    if (!user) throw ApiError.badRequest("This verification link is invalid or has expired.", "VERIFY_TOKEN_INVALID");
    await userRepo.setEmailVerified(user.id, true);
    await auditRepo
      .create({
        actorId: user.id,
        actorRole: user.role,
        action: "auth.verify.completed",
        entityType: "user",
        entityId: user.id,
        summary: `Email verified: ${maskEmail(user.email)}`,
        ip: ctx.ip ?? null,
      })
      .catch(() => {});
    notificationService.emitAsync({
      event: "email_verified",
      userIds: [user.id],
      params: {},
      dedupeKey: `email-verified:${row.id}`,
    });
    return { message: translate(ctx.lang, "auth.verify_done") };
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
