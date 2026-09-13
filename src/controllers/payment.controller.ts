import type { Request, Response } from "express";
import { paymentService } from "../services/payment.service.js";
import { shopService } from "../services/shop.service.js";
import { clampInt, str } from "../utils/validate.js";
import { ApiError } from "../utils/errors.js";
import type { SafeUser } from "../types.js";

/**
 * Payments & the transaction ledger.
 *
 * A `transactions` row is created when an order is placed and moves
 * `pending → successful | failed | cancelled`, with refunds as separate `kind =
 * 'refund'` rows. Confirmations and refunds are conditional updates inside one
 * transaction, so a double-click on "Confirm payment" cannot record two
 * successful charges for the same order.
 *
 * Amounts are never accepted from the client: the ledger mirrors the order
 * total the backend computed. `amount` on a refund is capped at the order total
 * by the service.
 */

function actor(req: Request): SafeUser {
  if (!req.user) throw ApiError.unauthorized();
  return req.user;
}

/** GET /api/payments/me — the caller's own ledger. */
export async function mine(req: Request, res: Response): Promise<void> {
  const user = actor(req);
  const limit = clampInt(req.query.limit, 25, 1, 100);
  const offset = clampInt(req.query.offset, 0, 0, 10000);
  const transactions = await paymentService.myTransactions(user.id, { limit, offset });
  res.json({ success: true, transactions, total: transactions.length, limit, offset });
}

/** GET /api/payments/order/:id — ledger for one order (owner or admin). */
export async function forOrder(req: Request, res: Response): Promise<void> {
  const user = actor(req);
  const transactions = await paymentService.ledgerForOrder(user, req.params.id);
  res.json({ success: true, order_id: req.params.id, transactions });
}

/** GET /api/admin/payments — ledger across all orders. */
export async function adminList(req: Request, res: Response): Promise<void> {
  actor(req);
  const out = await paymentService.adminList({
    status: str(req.query.status),
    limit: clampInt(req.query.limit, 50, 1, 100),
    offset: clampInt(req.query.offset, 0, 0, 100000),
  });
  res.json({ success: true, ...out });
}

/** GET /api/admin/payments/summary — totals for the dashboard. */
export async function adminSummary(req: Request, res: Response): Promise<void> {
  actor(req);
  res.json({ success: true, ...(await paymentService.summary()) });
}

/** POST /api/admin/orders/:id/confirm-payment — record a successful charge. */
export async function adminConfirm(req: Request, res: Response): Promise<void> {
  const user = actor(req);
  const body = req.body as Record<string, unknown>;
  const xff = req.headers["x-forwarded-for"];
  const ip = typeof xff === "string" && xff.trim() ? xff.split(",")[0].trim() : req.ip || null;
  const out = await paymentService.confirmOrderPayment(user, req.params.id, {
    gatewayRef: str(body.gateway_ref) ?? str(body.transaction_id) ?? null,
    note: str(body.note) ?? null,
    ip,
  });
  res.json({ success: true, ...out });
}

/**
 * POST /api/admin/orders/:id/refund — super admin only (`payments.refund`).
 * Refusing a refund twice is a real risk, so the service only writes when there
 * is a successful charge that has not already been refunded.
 */
export async function adminRefund(req: Request, res: Response): Promise<void> {
  const user = actor(req);
  const body = req.body as Record<string, unknown>;
  const amount = str(body.amount);
  const xff = req.headers["x-forwarded-for"];
  const ip = typeof xff === "string" && xff.trim() ? xff.split(",")[0].trim() : req.ip || null;
  const out = await paymentService.refundOrder(user, req.params.id, {
    amount: amount === undefined ? null : Number(amount),
    note: str(body.note) ?? null,
    ip,
  });
  res.json({ success: true, ...out });
}

/** GET /api/admin/payments/order/:id — same ledger, admin namespace. */
export async function adminOrderLedger(req: Request, res: Response): Promise<void> {
  const user = actor(req);
  const transactions = await paymentService.ledgerForOrder(user, req.params.id);
  const order = await shopService.withItems(req.params.id);
  res.json({
    success: true,
    order_id: req.params.id,
    transactions,
    order_total: Number(order.total),
    payment_status: order.payment_status,
  });
}
