import type { Request, Response } from "express";
import { adminService } from "../services/admin.service.js";
import { maintenanceService } from "../services/maintenance.service.js";
import { ApiError } from "../utils/errors.js";
import { clampInt, str } from "../utils/validate.js";
import { extFromMime, type UploadedImage } from "../uploads/uploads.js";
import type { SafeUser } from "../types.js";

function actor(req: Request): SafeUser {
  if (!req.user) throw ApiError.unauthorized();
  return req.user;
}

function filesFrom(req: Request): { logo?: UploadedImage | null; favicon?: UploadedImage | null } {
  const out: { logo?: UploadedImage | null; favicon?: UploadedImage | null } = {};
  const files = (req as Request & { files?: Record<string, Express.Multer.File[]> }).files;
  if (!files) return out;
  for (const field of ["logo", "favicon"] as const) {
    const f = files[field]?.[0];
    if (f && f.buffer) {
      out[field] = {
        originalName: f.originalname,
        mime: f.mimetype,
        data: Buffer.from(f.buffer),
        ext: extFromMime(f.mimetype),
      };
    }
  }
  return out;
}

// ------------------------------- dashboard -------------------------------

export async function dashboard(_req: Request, res: Response): Promise<void> {
  res.json(await adminService.dashboard());
}

// ------------------------------- settings -------------------------------

export async function settingsGet(_req: Request, res: Response): Promise<void> {
  res.json(await adminService.settingsGet());
}

export async function settingsPost(req: Request, res: Response): Promise<void> {
  res.json(await adminService.settingsPost(actor(req), req.body as Record<string, unknown>));
}

// ------------------------------- branding -------------------------------

export async function brandingGet(_req: Request, res: Response): Promise<void> {
  res.json(await adminService.brandingGet());
}

export async function brandingPost(req: Request, res: Response): Promise<void> {
  res.json(await adminService.brandingPost(actor(req), req.body as Record<string, unknown>, filesFrom(req)));
}

// --------------------------------- SMTP ---------------------------------

export async function smtpGet(_req: Request, res: Response): Promise<void> {
  res.json(await adminService.smtpGet());
}

export async function smtpPost(req: Request, res: Response): Promise<void> {
  res.json(await adminService.smtpPost(actor(req), req.body as Record<string, unknown>));
}

export async function smtpTest(req: Request, res: Response): Promise<void> {
  res.json(await adminService.smtpTest(actor(req), str(req.body.to) || undefined));
}

export async function smtpLog(_req: Request, res: Response): Promise<void> {
  res.json(await adminService.smtpLog());
}

// ----------------------------- content/antid -----------------------------

export async function antidList(_req: Request, res: Response): Promise<void> {
  res.json(await adminService.antidList());
}

export async function antidCreate(req: Request, res: Response): Promise<void> {
  res.json(await adminService.antidCreate(actor(req), req.body as Record<string, unknown>));
}

export async function antidUpdate(req: Request, res: Response): Promise<void> {
  res.json(await adminService.antidUpdate(actor(req), req.params.id, req.body as Record<string, unknown>));
}

export async function antidDelete(req: Request, res: Response): Promise<void> {
  res.json(await adminService.antidDelete(actor(req), req.params.id));
}

// --------------------------- content/resources ---------------------------

export async function resourcesList(_req: Request, res: Response): Promise<void> {
  res.json(await adminService.resourcesList());
}

export async function resourceCreate(req: Request, res: Response): Promise<void> {
  res.json(await adminService.resourceCreate(actor(req), req.body as Record<string, unknown>));
}

export async function resourceUpdate(req: Request, res: Response): Promise<void> {
  res.json(await adminService.resourceUpdate(actor(req), req.params.id, req.body as Record<string, unknown>));
}

export async function resourceDelete(req: Request, res: Response): Promise<void> {
  res.json(await adminService.resourceDelete(actor(req), req.params.id));
}

// ------------------------------- activity -------------------------------

export async function activityEvents(_req: Request, res: Response): Promise<void> {
  res.json(await adminService.activityEvents());
}

export async function activityAnnounce(req: Request, res: Response): Promise<void> {
  res.json(await adminService.announce(actor(req), req.body as Record<string, unknown>));
}

// ------------------------------ site notice ------------------------------

export async function noticeSet(req: Request, res: Response): Promise<void> {
  res.json(await adminService.setNotice(actor(req), req.body as Record<string, unknown>));
}

export async function noticeClear(req: Request, res: Response): Promise<void> {
  res.json(await adminService.clearNotice(actor(req)));
}

// --------------------- donor verification / roles ---------------------

export async function verifyDonor(req: Request, res: Response): Promise<void> {
  res.json(await adminService.verifyDonor(actor(req), req.params.id));
}

export async function promote(req: Request, res: Response): Promise<void> {
  res.json(await adminService.promote(actor(req), req.params.id));
}

export async function demote(req: Request, res: Response): Promise<void> {
  res.json(await adminService.demote(actor(req), req.params.id));
}

// ------------------------------ super admin ------------------------------

export async function userDelete(req: Request, res: Response): Promise<void> {
  res.json(await adminService.deleteUser(actor(req), req.params.id));
}

export async function userUpdate(req: Request, res: Response): Promise<void> {
  res.json(await adminService.updateUser(actor(req), req.params.id, req.body as Record<string, unknown>));
}

export async function userDetails(req: Request, res: Response): Promise<void> {
  res.json(await adminService.userDetails(actor(req), req.params.id));
}

export async function createAdmin(req: Request, res: Response): Promise<void> {
  res.json(await adminService.createAdmin(actor(req), req.body as Record<string, unknown>));
}

export async function impersonate(req: Request, res: Response): Promise<void> {
  res.json(await adminService.impersonate(actor(req), req.params.id));
}

export async function switchBack(req: Request, res: Response): Promise<void> {
  res.json(await adminService.switchBack(actor(req), str(req.body.impersonated_user_id) || undefined));
}

export async function backup(_req: Request, res: Response): Promise<void> {
  res.json(await adminService.backup());
}

// ------------------------------- mail outbox -------------------------------

/**
 * GET /api/admin/mail/outbox — the durable mail queue.
 *
 * Every outgoing message is written here BEFORE any SMTP attempt, so a mail host
 * that is down or slow delays mail instead of failing the operation that caused
 * it (an order confirmation must never cost somebody their order). This view
 * shows what is waiting, what went out and what exhausted its retries.
 */
export async function mailOutbox(req: Request, res: Response): Promise<void> {
  actor(req);
  res.json(
    await maintenanceService.mailStatus(clampInt(req.query.limit, 25, 1, 100), str(req.query.status) ?? null),
  );
}

/** POST /api/admin/mail/flush — retry the queued mail now. */
export async function mailFlush(req: Request, res: Response): Promise<void> {
  actor(req);
  const out = await maintenanceService.flushMail(clampInt(req.body?.limit, 20, 1, 100));
  res.json({ success: out.ok, task: out.task, ...(out.detail ?? {}), error: out.error ?? null });
}

// -------------------------------- maintenance --------------------------------

/**
 * POST /api/admin/maintenance — one idempotent sweep.
 *
 * Serverless has no background timer, so retention work (expired reset tokens,
 * stale rate-limit buckets, bounded history tables) only happens when something
 * asks for it. Call this from the panel or point an external cron at it.
 */
export async function maintenance(req: Request, res: Response): Promise<void> {
  actor(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const out = await maintenanceService.run({
    flushMail: body.flush_mail === undefined ? true : Boolean(body.flush_mail),
    mailLimit: clampInt(body.mail_limit, 20, 1, 100),
  });
  res.json(out);
}
