import type { Request, Response } from "express";
import { userService } from "../services/user.service.js";
import { ApiError } from "../utils/errors.js";
import { uploadService } from "../services/upload.service.js";
import { readUpload } from "../uploads/uploads.js";
import { str } from "../utils/validate.js";

/** GET /api/donors — public verified donor directory with filters. */
export async function listDonors(req: Request, res: Response): Promise<void> {
  const donors = await userService.listDonors({
    bg: str(req.query.bg) || undefined,
    dist: str(req.query.dist) || undefined,
    upa: str(req.query.upa) || undefined,
    ageMin: Number(str(req.query.age_min)) || undefined,
  });
  // `users` is the original contract key; `donors` kept for the old client.
  res.json({ success: true, users: donors, donors });
}

/**
 * GET /api/user/dashboard — the signed-in caller's personal overview.
 *
 * One aggregate call instead of six: identity, donation eligibility, order and
 * request counts, unread badges, spend and the most recent items. Everything is
 * scoped to the session user; no id is read from the request.
 */
export async function dashboard(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  res.json(await userService.dashboard(req.user));
}

/**
 * PATCH /api/users/me/preferences — {language?, notify_email?, notify_inapp?}.
 * Returns the updated account so the client can apply the new language at once.
 */
export async function setPreferences(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const user = await userService.setPreferences(req.user.id, (req.body ?? {}) as Record<string, unknown>);
  res.json({ success: true, user, message: "✅ Preferences saved." });
}

/** GET /api/users/:id — public profile. */
export async function publicProfile(req: Request, res: Response): Promise<void> {
  const user = await userService.publicProfile(req.params.id);
  res.json({ success: true, user });
}

/** PUT /api/users/me — self-service profile edit (multipart, optional profile_pic). */
export async function updateSelf(req: Request, res: Response): Promise<void> {
  if (!req.user) throw new Error("LOGIN_REQUIRED");
  const file = readUpload(req);
  const imageFile = file ? await uploadService.store(file) : null;
  const out = await userService.selfUpdate(
    req.user.id,
    {
      name: str(req.body.name),
      phone: str(req.body.phone),
      holding: str(req.body.holding),
      birth_certificate: str(req.body.birth_certificate),
      date_of_birth: str(req.body.date_of_birth),
    },
    imageFile,
  );
  res.json({ success: true, ...out });
}

/** POST /api/users/me/toggle-status — donation availability. */
export async function toggleStatus(req: Request, res: Response): Promise<void> {
  if (!req.user) throw new Error("LOGIN_REQUIRED");
  const out = await userService.toggleStatus(req.user.id);
  res.json({ success: true, ...out });
}

/** POST /api/users/me/apply-verification — 18+ gate. */
export async function applyVerification(req: Request, res: Response): Promise<void> {
  if (!req.user) throw new Error("LOGIN_REQUIRED");
  const out = await userService.applyVerification(req.user.id);
  res.json({ success: true, ...out });
}
