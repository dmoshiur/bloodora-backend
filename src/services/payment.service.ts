import { transactionRepo, newReference, type TransactionRow } from "../repos/transaction.repo.js";
import { orderRepo } from "../repos/order.repo.js";
import { userRepo } from "../repos/user.repo.js";
import { auditRepo } from "../repos/audit.repo.js";
import { notificationService } from "./notification.service.js";
import { rbacService } from "./rbac.service.js";
import { emailService } from "./email.service.js";
import { ApiError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { SafeUser } from "../types.js";

/**
 * Payments.
 *
 * BloodOra takes payment through mobile financial services (bKash, Nagad, Upay,
 * Rocket, Pathao), card or cash on delivery. There is no hosted gateway in this
 * deployment, so the money movement is: customer sends money and submits the
 * TrxID → the order is created with `payment_status = 'pending'` and a `pending`
 * ledger row → an admin confirms → the ledger row becomes `successful`.
 *
 * The rules that matter for correctness:
 *
 *  - **The client never states an amount.** Every ledger row is written from the
 *    stored order total, which was itself priced from the product table at
 *    checkout (`shopService.priceCart`). A tampered request body cannot change
 *    what is charged.
 *  - **A "payment successful" claim from the browser means nothing.** Only
 *    `confirmOrderPayment` — an admin action, permission-checked and audited —
 *    moves a transaction to `successful`.
 *  - **Confirmation is idempotent.** It is a conditional UPDATE, so a double
 *    click, a retried request or two admins acting at once produce exactly one
 *    successful transaction and one notification.
 *  - **Refunds are ledger entries**, never an edit of the original charge.
 *
 * If a real gateway is added later (SSLCommerz / Stripe / bKash tokenized),
 * `gateway` and `gateway_ref` are where the provider id and webhook reference go
 * and `confirmOrderPayment` becomes the webhook-verified path; nothing above
 * changes.
 */

export interface TransactionView {
  id: string;
  reference: string;
  order_id: string | null;
  amount: number;
  currency: string;
  method: string;
  kind: string;
  status: string;
  gateway: string | null;
  gateway_ref: string | null;
  note: string | null;
  confirmed_at: string | null;
  created_at: string;
}

export function shapeTransaction(row: TransactionRow): TransactionView {
  return {
    id: row.id,
    reference: row.reference,
    order_id: row.order_id,
    amount: Number(row.amount),
    currency: row.currency,
    method: row.method,
    kind: row.kind,
    status: row.status,
    gateway: row.gateway,
    // The customer's own TrxID is theirs to see; provider internals are not.
    gateway_ref: row.gateway_ref,
    note: row.note,
    confirmed_at: row.confirmed_at,
    created_at: row.created_at,
  };
}

export const paymentService = {
  /**
   * Guarantee exactly one live charge row for an order. Called when the order is
   * placed and again (defensively) before any status read, so an order created
   * before the ledger existed still gets a row.
   */
  async ensureCharge(orderId: string): Promise<TransactionRow | null> {
    const existing = await transactionRepo.chargeForOrder(orderId);
    if (existing) return existing;
    // A cancelled or failed charge is history, not an empty slot: creating
    // another row here would put two charges for one order in the books and make
    // the totals lie.
    const closed = await transactionRepo.anyChargeForOrder(orderId);
    if (closed) return closed;
    const order = await orderRepo.findById(orderId);
    if (!order) return null;
    try {
      return await transactionRepo.create({
        reference: newReference(),
        orderId,
        userId: order.user_id,
        amount: Number(order.total),
        currency: "BDT",
        method: order.payment_method || "cod",
        kind: "charge",
        status: order.payment_status === "confirmed" ? "successful" : "pending",
        gateway: "manual",
        gatewayRef: order.payment_ref ?? null,
        note: null,
      });
    } catch (err) {
      logger.warn("payment: could not create the ledger row", { order: orderId, err: String((err as Error)?.message ?? err) });
      return null;
    }
  },

  /** POST /api/admin/orders/:id/confirm-payment */
  async confirmOrderPayment(
    actor: SafeUser,
    orderId: string,
    opts: { gatewayRef?: string | null; note?: string | null; ip?: string | null } = {},
  ): Promise<{ message: string; duplicate: boolean; transaction: TransactionView | null }> {
    const order = await orderRepo.findById(orderId);
    if (!order) throw ApiError.notFound("Order not found.", "ORDER_NOT_FOUND");
    if (order.status === "cancelled") {
      // The items were restocked and the charge was closed when it was cancelled.
      // Taking money for it now would leave the ledger and the warehouse
      // disagreeing, so the order has to be reopened first.
      throw ApiError.conflict("This order is cancelled — reopen it before confirming a payment.", "ORDER_CANCELLED");
    }
    await this.ensureCharge(orderId);

    const result = await transactionRepo.confirmOrderCharge(orderId, actor.id, {
      gatewayRef: opts.gatewayRef ?? null,
      note: opts.note ?? null,
      method: null,
    });

    if (!result.confirmed) {
      // Already successful (or refunded): report the truth, create nothing.
      return {
        message: "ℹ️ Payment already confirmed.",
        duplicate: true,
        transaction: result.transaction ? shapeTransaction(result.transaction) : null,
      };
    }

    const tx = result.transaction;
    await auditRepo
      .create({
        actorId: actor.id,
        actorRole: actor.role || null,
        action: "payment.confirm",
        entityType: "order",
        entityId: orderId,
        summary: `Payment confirmed (${tx?.reference ?? "?"}) — ৳${Number(tx?.amount ?? order.total).toFixed(2)}`,
        meta: { amount: tx?.amount ?? order.total, method: order.payment_method, gateway_ref: opts.gatewayRef ?? order.payment_ref ?? null },
        ip: opts.ip ?? null,
      })
      .catch(() => {});

    notificationService.emitAsync({
      event: "payment_confirmed",
      userIds: [order.user_id],
      params: { id: orderId, amount: `৳${Number(tx?.amount ?? order.total).toFixed(2)}` },
      entityType: "order",
      entityId: orderId,
      dedupeKey: `payment-confirmed:${orderId}`,
    });
    void emailService.paymentConfirmed(orderId, Number(tx?.amount ?? order.total)).catch((e) => {
      logger.warn("payment: confirmation email failed", { err: String(e) });
    });
    logger.info("payment: confirmed", { order: orderId, actor: actor.id, reference: tx?.reference });

    return {
      message: "✅ Payment confirmed!",
      duplicate: false,
      transaction: tx ? shapeTransaction(tx) : null,
    };
  },

  /** POST /api/admin/orders/:id/refund — super admin (`payments.refund`). */
  async refundOrder(
    actor: SafeUser,
    orderId: string,
    opts: { amount?: number | null; note?: string | null; ip?: string | null } = {},
  ): Promise<{ message: string; transaction: TransactionView | null }> {
    const order = await orderRepo.findById(orderId);
    if (!order) throw ApiError.notFound("Order not found.", "ORDER_NOT_FOUND");

    const requested = opts.amount === null || opts.amount === undefined ? Number(order.total) : Number(opts.amount);
    if (!Number.isFinite(requested) || requested <= 0) {
      throw ApiError.badRequest("Refund amount must be a positive number.", "BAD_AMOUNT");
    }
    if (requested > Number(order.total) + 0.001) {
      throw ApiError.badRequest("Refund amount cannot exceed the order total.", "REFUND_TOO_LARGE");
    }

    const out = await transactionRepo.refundOrderCharge(orderId, {
      amount: requested,
      actorId: actor.id,
      note: opts.note ?? null,
    });
    if (!out.ok) {
      throw ApiError.conflict(
        out.reason === "ALREADY_REFUNDED"
          ? "This order has already been refunded."
          : "There is no confirmed payment to refund on this order.",
        out.reason === "ALREADY_REFUNDED" ? "ALREADY_REFUNDED" : "NO_SUCCESSFUL_CHARGE",
      );
    }

    await auditRepo
      .create({
        actorId: actor.id,
        actorRole: actor.role || null,
        action: "payment.refund",
        entityType: "order",
        entityId: orderId,
        summary: `Refund ৳${requested.toFixed(2)} (${out.refund?.reference ?? "?"})`,
        meta: { amount: requested, note: opts.note ?? null },
        ip: opts.ip ?? null,
      })
      .catch(() => {});

    notificationService.emitAsync({
      event: "payment_refunded",
      userIds: [order.user_id],
      params: { id: orderId, amount: `৳${requested.toFixed(2)}` },
      title: `Refund issued — ৳${requested.toFixed(2)}`,
      entityType: "order",
      entityId: orderId,
      dedupeKey: `refund:${out.refund?.id ?? orderId}`,
    });

    return {
      message: `💸 Refund of ৳${requested.toFixed(2)} recorded for this order.`,
      transaction: out.refund ? shapeTransaction(out.refund) : null,
    };
  },

  /** Called when an order is cancelled before payment: close the ledger row. */
  async cancelCharge(orderId: string): Promise<void> {
    try {
      await transactionRepo.markCancelled(orderId);
    } catch (err) {
      logger.warn("payment: could not cancel the ledger row", { order: orderId, err: String((err as Error)?.message ?? err) });
    }
  },

  async markFailed(orderId: string, reason?: string): Promise<void> {
    try {
      await transactionRepo.markFailed(orderId, reason ?? null);
    } catch (err) {
      logger.warn("payment: could not mark the ledger row failed", { order: orderId, err: String((err as Error)?.message ?? err) });
    }
  },

  /** GET /api/shop/orders/:id/transactions (owner or admin). */
  async ledgerForOrder(user: SafeUser, orderId: string): Promise<TransactionView[]> {
    const order = await orderRepo.findById(orderId);
    if (!order) throw ApiError.notFound("Order not found.", "ORDER_NOT_FOUND");
    if (order.user_id !== user.id) {
      // Not the owner: require the actual permission. The legacy `is_admin` flag
      // is set for ANY non-`user` role, so a custom role (e.g. a content editor)
      // would otherwise be able to read every customer's payment ledger.
      const allowed = await rbacService.can(user, "payments.view");
      if (!allowed) throw ApiError.forbidden("❌ Unauthorized.", "FORBIDDEN");
    }
    await this.ensureCharge(orderId);
    const rows = await transactionRepo.listForOrder(orderId);
    return rows.map(shapeTransaction);
  },

  /** GET /api/user/transactions — the caller's own ledger. */
  async myTransactions(userId: string, opts: { limit?: number; offset?: number } = {}) {
    const rows = await transactionRepo.listForUser(userId, opts.limit ?? 25, opts.offset ?? 0);
    return rows.map(shapeTransaction);
  },

  /** Admin dashboard + analytics figures. */
  async summary(): Promise<{
    pending: number;
    successful: number;
    failed: number;
    refunded: number;
    cancelled: number;
    collected: number;
    refundedAmount: number;
  }> {
    const [pending, successful, failed, refunded, cancelled, collected, refundedAmount] = await Promise.all([
      transactionRepo.countByStatus("pending"),
      transactionRepo.countByStatus("successful"),
      transactionRepo.countByStatus("failed"),
      transactionRepo.countByStatus("refunded"),
      transactionRepo.countByStatus("cancelled"),
      transactionRepo.sumByStatus("successful"),
      transactionRepo.sumRefunds(),
    ]);
    return { pending, successful, failed, refunded, cancelled, collected, refundedAmount };
  },

  /** Admin ledger view with the payer's name attached. */
  async adminList(opts: { status?: string; limit?: number; offset?: number } = {}): Promise<{ transactions: (TransactionView & { user_name: string | null })[]; total: number }> {
    const rows = await transactionRepo.recent(Math.min(100, opts.limit ?? 50));
    const filtered = opts.status ? rows.filter((r) => r.status === opts.status) : rows;
    const withNames = await Promise.all(
      filtered.map(async (r) => {
        const u = await userRepo.findById(r.user_id);
        return { ...shapeTransaction(r), user_name: u?.name ?? null };
      }),
    );
    return { transactions: withNames, total: withNames.length };
  },
};
