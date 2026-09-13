import bcrypt from "bcryptjs";
import { userRepo } from "../repos/user.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { settingsRepo } from "../repos/settings.repo.js";
import { ApiError, maskPhone } from "../utils/errors.js";
import { str } from "../utils/validate.js";
import type { SafeUser, UserRow } from "../types.js";

export const userService = {
  async updateProfile(userId: string, body: Record<string, unknown>): Promise<SafeUser> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");

    const name = str(body.name);
    const email = str(body.email);
    const phone = str(body.phone);
    const bloodGroup = str(body.blood_group);
    const city = str(body.city);

    if (email && email.toLowerCase() !== row.email.toLowerCase()) {
      const taken = await userRepo.findByEmail(email);
      if (taken) throw ApiError.conflict("Email already in use", "EMAIL_TAKEN");
    }

    await userRepo.updateProfile(userId, {
      ...(name ? { name } : {}),
      ...(email ? { email: email.toLowerCase() } : {}),
      ...(phone ? { phone } : {}),
      ...(bloodGroup ? { blood_group: bloodGroup } : {}),
      ...(city ? { city } : {}),
    });

    await activityRepo.create("profile", userId, `${name || row.name} updated their profile`);
    const fresh = (await userRepo.findById(userId))!;
    const { password_hash: _p, session_token: _s, ...safe } = fresh;
    return safe;
  },

  async setProfileImage(userId: string, imageFile: string): Promise<SafeUser> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");
    await userRepo.updateProfile(userId, { image_file: imageFile });
    const fresh = (await userRepo.findById(userId))!;
    const { password_hash: _p, session_token: _s, ...safe } = fresh;
    return safe;
  },

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");
    const ok = await bcrypt.compare(current, row.password_hash);
    if (!ok) throw ApiError.unauthorized("Current password is incorrect", "BAD_CREDENTIALS");
    if (next.length < 8) throw ApiError.badRequest("New password must be at least 8 characters", "PASSWORD_SHORT");
    await userRepo.setPassword(userId, await bcrypt.hash(next, 10));
    await activityRepo.create("password", userId, "A password was changed");
  },

  async setVerification(userId: string, verified: boolean): Promise<SafeUser> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");
    await userRepo.setVerified(userId, verified);
    await activityRepo.create(verified ? "verify" : "unverify", userId, verified ? `${row.name} was verified as a donor` : `${row.name} was unverified`);
    const fresh = (await userRepo.findById(userId))!;
    const { password_hash: _p, session_token: _s, ...safe } = fresh;
    return safe;
  },

  async listDonors(opts: { bg?: string; dist?: string; upa?: string; ageMin?: number } = {}): Promise<SafeUser[]> {
    const rows = await userRepo.listDonors({
      bg: opts.bg,
      dist: opts.dist,
      upa: opts.upa,
      ageMin: opts.ageMin,
      limit: 200,
    });
    return rows.map(normalizeFlags);
  },

  /** GET /api/users/:id — full profile (flags normalized to booleans). */
  async publicProfile(id: string): Promise<SafeUser> {
    const row = await userRepo.findById(id);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");
    return normalizeFlags(row);
  },

  /** PUT /api/users/me — self-service edit (multipart fields + optional image). */
  async selfUpdate(
    userId: string,
    fields: { name?: string; phone?: string; holding?: string; birth_certificate?: string; date_of_birth?: string },
    imageFile?: string | null,
  ): Promise<{ user: SafeUser; message: string }> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");

    let dob = row.date_of_birth;
    let age = row.age;
    if (fields.date_of_birth) {
      dob = fields.date_of_birth;
      const computed = calculateAge(fields.date_of_birth);
      if (computed != null) age = computed;
    }

    await userRepo.updateProfile(userId, {
      ...(fields.name ? { name: fields.name } : {}),
      ...(fields.phone ? { phone: fields.phone } : {}),
      ...(fields.holding !== undefined ? { address_holding: fields.holding || null } : {}),
      ...(fields.birth_certificate !== undefined ? { birth_certificate_number: fields.birth_certificate || null } : {}),
      ...(fields.date_of_birth ? { date_of_birth: dob, age } : {}),
      ...(imageFile ? { image_file: imageFile } : {}),
    });
    const fresh = (await userRepo.findById(userId))!;
    return { user: normalizeFlags(fresh), message: "✅ Profile updated successfully!" };
  },

  /** POST /api/users/me/toggle-status — donation availability. */
  async toggleStatus(userId: string): Promise<{ can_donate: boolean; message: string }> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");
    const next = await userRepo.toggleCanDonate(userId, row.can_donate);
    await activityRepo.create("donation", userId, `${row.name} marked themselves ${next ? "available" : "unavailable"} for donation`);
    return {
      can_donate: next === 1,
      message: `✅ Donation status updated: ${next ? "Available" : "Unavailable"}`,
    };
  },

  /** POST /api/users/me/apply-verification — 18+ gate, admin reviews after. */
  async applyVerification(userId: string): Promise<{ type: string; message: string }> {
    const row = await userRepo.findById(userId);
    if (!row) throw ApiError.notFound("User not found", "USER_NOT_FOUND");
    if (row.age && row.age >= 18) {
      await activityRepo.create("verify", userId, `${row.name} applied for donor verification`, { stage: "applied" });
      return { type: "info", message: "ℹ️ Verification request submitted. Admin will review within 24 hours." };
    }
    throw ApiError.badRequest("⚠️ You must be 18+ to apply.", "UNDER_18");
  },

  async donateCount(): Promise<number> {
    const raw = await settingsRepo.get("total_donations");
    return raw ? Number(raw) : 0;
  },
};

/** 0/1 flag columns → booleans (matches the original API contract). */
function normalizeFlags(row: UserRow): SafeUser {
  const { password_hash: _p, session_token: _s, ...safe } = row as unknown as Record<string, unknown>;
  return {
    ...safe,
    is_admin: Boolean(safe.is_admin),
    is_super_admin: Boolean(safe.is_super_admin),
    is_verified: Boolean(safe.is_verified),
    can_donate: Boolean(safe.can_donate),
  } as unknown as SafeUser;
}

function calculateAge(dob: string): number | null {
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}
