import type { Request, Response } from "express";
import { bloodRequestService } from "../services/bloodRequest.service.js";
import { str } from "../utils/validate.js";
import { ApiError } from "../utils/errors.js";

/** GET /api/blood-requests?bg=&dist=&division=&urgent= */
export async function listRequests(req: Request, res: Response): Promise<void> {
  const out = await bloodRequestService.listPublic({
    bg: str(req.query.bg),
    dist: str(req.query.dist),
    division: str(req.query.division),
    urgent: str(req.query.urgent),
  });
  res.json(out);
}

/** GET /api/blood-requests/urgent */
export async function urgentList(req: Request, res: Response): Promise<void> {
  res.json(await bloodRequestService.urgentList());
}

/** POST /api/blood-requests — guests allowed. */
export async function createRequest(req: Request, res: Response): Promise<void> {
  const out = await bloodRequestService.create(req.user ?? null, req.body as Record<string, unknown>);
  res.json({ success: true, ...out });
}

/** GET /api/blood-requests/:id */
export async function getRequest(req: Request, res: Response): Promise<void> {
  res.json({ success: true, request: await bloodRequestService.get(req.params.id) });
}

/** POST /api/blood-requests/:id/fulfill */
export async function fulfillRequest(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const out = await bloodRequestService.fulfill(req.user, req.params.id);
  res.json({ success: true, ...out });
}

/** POST /api/blood-requests/:id/cancel */
export async function cancelRequest(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const out = await bloodRequestService.cancel(req.user, req.params.id);
  res.json({ success: true, ...out });
}

/** POST /api/blood-requests/urgent-contact */
export async function urgentContact(req: Request, res: Response): Promise<void> {
  const out = await bloodRequestService.urgentContact(req.user ?? null, req.body as Record<string, unknown>);
  res.json({ success: true, ...out });
}

/** GET /api/blood-requests/mine — auth: my requests. */
export async function myRequests(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const requests = await bloodRequestService.mine(req.user.id);
  res.json({ requests });
}

// ---------- admin ----------

/** GET /api/admin/blood-requests/:id */
export async function getAdminRequest(req: Request, res: Response): Promise<void> {
  res.json({ success: true, request: await bloodRequestService.get(req.params.id) });
}

/** PATCH /api/admin/blood-requests/:id/status */
export async function setRequestStatus(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const status = str(req.body.status);
  const request = await bloodRequestService.setStatus(req.user, req.params.id, str(req.body.status) ?? "");
  res.json({ request });
}

/** DELETE /api/admin/blood-requests/:id */
export async function deleteRequest(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  await bloodRequestService.remove(req.user, req.params.id);
  res.json({ ok: true });
}
