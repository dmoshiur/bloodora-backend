import { all, get, run, transaction, type TxExecutor } from "../db/query.js";
import { nowIso } from "../utils/time.js";
import { randomId } from "../utils/errors.js";

/**
 * Payment ledger.
 *
 * One row per money movement. Orders keep their own denormalized
 * `payment_status` for the original contract, but the ledger is the audit truth:
 * who confirmed what, when, against which gateway reference, and every refund.
 *
 * Duplicate protection is structural, not best-effort:
 *   - `reference` is UNIQUE (the customer-facing TXN id);
 *   - a charge is created inside the same transaction as the order, and
 *     `chargeForOrder()` returns the existing row instead of inserting again;
 *   - confirmation is a conditional UPDATE (`status != 'successful'`), so two
 *     admins clicking "confirm payment" at the same moment produce exactly one
 *     successful transaction.
 */

export type TransactionStatus = "pending" | "processing" | "successful" | "failed" | "cancelled" | "refunded";
export type TransactionKind = "charge" | "refund";

export interface TransactionRow {
  id: string;
  reference: string;
  order_id: string | null;
  user_id: string;
  amount: number;
  currency: string;
  method: string;
  kind: TransactionKind;
  status: TransactionStatus;
  gateway: string | null;
  gateway_ref: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  note: string | null;
  meta: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewTransaction {
  id?: string;
  reference?: string;
  orderId?: string | null;
  userId: string;
  amount: number;
  currency?: string;
  method: string;
  kind?: TransactionKind;
  status?: TransactionStatus;
  gateway?: string | null;
  gatewayRef?: string | null;
  note?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Human-readable, collision-resistant payment reference: TXN-XXXXXXXX. */
export function newReference(prefix = "TXN"): string {
  return `${prefix}-${randomId(4).toUpperCase()}`;
}

export const transactionRepo = {
  async create(t: NewTransaction): Promise<TransactionRow> {
    const id = t.id ?? randomId();
    const at = nowIso();
    await run(
      `INSERT INTO transactions
         (id, reference, order_id, user_id, amount, currency, method, kind, status, gateway, gateway_ref, note, meta, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        t.reference ?? newReference(),
        t.orderId ?? null,
        t.userId,
        t.amount,
        t.currency ?? "BDT",
        t.method,
        t.kind ?? "charge",
        t.status ?? "pending",
        t.gateway ?? null,
        t.gatewayRef ?? null,
        t.note ?? null,
        t.meta ? JSON.stringify(t.meta) : null,
        at,
        at,
      ],
    );
    return (await this.findById(id))!;
  },

  async findById(id: string): Promise<TransactionRow | null> {
    return get<TransactionRow>(`SELECT * FROM transactions WHERE id = ?`, [id]);
  },

  async findByReference(reference: string): Promise<TransactionRow | null> {
    return get<TransactionRow>(`SELECT * FROM transactions WHERE reference = ?`, [reference]);
  },

  /** The live charge for an order (never a cancelled one). */
  async chargeForOrder(orderId: string): Promise<TransactionRow | null> {
    return get<TransactionRow>(
      `SELECT * FROM transactions WHERE order_id = ? AND kind = 'charge' AND status != 'cancelled'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [orderId],
    );
  },

  /**
   * The most recent charge row for an order REGARDLESS of status.
   *
   * `chargeForOrder()` deliberately ignores cancelled rows (callers want a live
   * charge to act on). Creating a ledger entry needs the opposite question —
   * "does this order already have a charge in the books?" — otherwise a cancelled
   * order looks charge-less and gets a brand-new pending row every time somebody
   * opens it.
   */
  async anyChargeForOrder(orderId: string): Promise<TransactionRow | null> {
    return get<TransactionRow>(
      `SELECT * FROM transactions WHERE order_id = ? AND kind = 'charge'
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      [orderId],
    );
  },

  async listForOrder(orderId: string): Promise<TransactionRow[]> {
    return all<TransactionRow>(`SELECT * FROM transactions WHERE order_id = ? ORDER BY created_at ASC, rowid ASC`, [orderId]);
  },

  async listForUser(userId: string, limit = 50, offset = 0): Promise<TransactionRow[]> {
    return all<TransactionRow>(
      `SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      [userId, Math.min(100, Math.max(1, limit)), Math.max(0, offset)],
    );
  },

  async recent(limit = 20): Promise<TransactionRow[]> {
    return all<TransactionRow>(`SELECT * FROM transactions ORDER BY created_at DESC, rowid DESC LIMIT ?`, [
      Math.min(100, Math.max(1, limit)),
    ]);
  },

  async countByStatus(status: TransactionStatus): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM transactions WHERE status = ?`, [status]);
    return row?.n ?? 0;
  },

  async sumByStatus(status: TransactionStatus): Promise<number> {
    const row = await get<{ s: number | null }>(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE status = ? AND kind = 'charge'`,
      [status],
    );
    return Number(row?.s ?? 0);
  },

  async sumRefunds(): Promise<number> {
    const row = await get<{ s: number | null }>(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions WHERE kind = 'refund' AND status = 'successful'`,
    );
    return Number(row?.s ?? 0);
  },

  async countCreatedAfter(sinceIso: string): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM transactions WHERE created_at >= ?`, [sinceIso]);
    return row?.n ?? 0;
  },

  async sumCreatedAfter(sinceIso: string, status?: TransactionStatus): Promise<number> {
    const row = await get<{ s: number | null }>(
      `SELECT COALESCE(SUM(amount), 0) AS s FROM transactions
       WHERE created_at >= ? AND kind = 'charge'${status ? " AND status = ?" : ""}`,
      status ? [sinceIso, status] : [sinceIso],
    );
    return Number(row?.s ?? 0);
  },

  /**
   * Confirm an order's charge atomically with the order's payment_status.
   *
   * Both UPDATEs are conditional, so the winner of a race is decided by the
   * database: exactly one caller sees `confirmed === true` and every other
   * caller sees `confirmed === false` with the already-successful row.
   */
  async confirmOrderCharge(
    orderId: string,
    actorId: string,
    opts: { gatewayRef?: string | null; note?: string | null; method?: string | null } = {},
  ): Promise<{ confirmed: boolean; transaction: TransactionRow | null }> {
    return transaction(async (tx: TxExecutor) => {
      const at = nowIso();
      const claim = await tx.run(
        `UPDATE transactions
            SET status = 'successful',
                confirmed_by = ?,
                confirmed_at = ?,
                updated_at = ?,
                gateway_ref = COALESCE(?, gateway_ref),
                method = COALESCE(?, method),
                note = COALESCE(?, note)
          WHERE order_id = ? AND kind = 'charge' AND status IN ('pending', 'processing', 'failed')`,
        [actorId, at, at, opts.gatewayRef ?? null, opts.method ?? null, opts.note ?? null, orderId],
      );
      // Keep the order's denormalized flag in step with the ledger — but ONLY
      // when a row actually changed. Updating it unconditionally would mark a
      // cancelled order (whose charge can never be claimed) as paid.
      if (claim.changes > 0) {
        await tx.run(`UPDATE orders SET payment_status = 'confirmed' WHERE id = ? AND payment_status != 'confirmed'`, [orderId]);
      }
      const row = await tx.get<TransactionRow>(
        `SELECT * FROM transactions WHERE order_id = ? AND kind = 'charge' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        [orderId],
      );
      return { confirmed: claim.changes > 0, transaction: row ?? null };
    });
  },

  async markFailed(orderId: string, reason?: string | null): Promise<boolean> {
    const { changes } = await run(
      `UPDATE transactions SET status = 'failed', note = COALESCE(?, note), updated_at = ?
       WHERE order_id = ? AND kind = 'charge' AND status IN ('pending', 'processing')`,
      [reason ?? null, nowIso(), orderId],
    );
    return changes > 0;
  },

  async markCancelled(orderId: string): Promise<boolean> {
    const { changes } = await run(
      `UPDATE transactions SET status = 'cancelled', updated_at = ?
       WHERE order_id = ? AND kind = 'charge' AND status IN ('pending', 'processing')`,
      [nowIso(), orderId],
    );
    return changes > 0;
  },

  /**
   * Record a refund against an order's successful charge. The charge flips to
   * `refunded` in the same transaction, so a second refund attempt finds no
   * successful charge to refund and is rejected by the caller.
   */
  async refundOrderCharge(
    orderId: string,
    input: { amount: number; actorId: string; note?: string | null; method?: string | null },
  ): Promise<{ ok: boolean; refund: TransactionRow | null; reason?: string }> {
    return transaction(async (tx: TxExecutor) => {
      const at = nowIso();
      const charge = await tx.get<TransactionRow>(
        `SELECT * FROM transactions WHERE order_id = ? AND kind = 'charge' AND status = 'successful'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
        [orderId],
      );
      if (!charge) return { ok: false, refund: null, reason: "NO_SUCCESSFUL_CHARGE" };
      const already = await tx.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM transactions WHERE order_id = ? AND kind = 'refund' AND status != 'cancelled'`,
        [orderId],
      );
      if ((already?.n ?? 0) > 0) return { ok: false, refund: null, reason: "ALREADY_REFUNDED" };
      const amount = Math.min(Math.max(0, input.amount), Number(charge.amount));
      const id = randomId();
      await tx.run(
        `INSERT INTO transactions
           (id, reference, order_id, user_id, amount, currency, method, kind, status, gateway, gateway_ref, confirmed_by, confirmed_at, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'refund', 'successful', ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          newReference("RFD"),
          orderId,
          charge.user_id,
          amount,
          charge.currency,
          input.method ?? charge.method,
          charge.gateway,
          charge.gateway_ref,
          input.actorId,
          at,
          input.note ?? null,
          at,
          at,
        ],
      );
      await tx.run(`UPDATE transactions SET status = 'refunded', updated_at = ? WHERE id = ?`, [at, charge.id]);
      await tx.run(`UPDATE orders SET payment_status = 'refunded' WHERE id = ?`, [orderId]);
      const refund = await tx.get<TransactionRow>(`SELECT * FROM transactions WHERE id = ?`, [id]);
      return { ok: true, refund: refund ?? null };
    });
  },

  async prune(keep = 20000): Promise<number> {
    // Ledger rows are financial records — pruning is retention, not cleanup, so
    // it only ever removes terminal rows beyond the retention window.
    const { changes } = await run(
      `DELETE FROM transactions WHERE status IN ('cancelled', 'failed')
         AND rowid NOT IN (SELECT rowid FROM transactions ORDER BY rowid DESC LIMIT ?)`,
      [keep],
    );
    return changes;
  },
};
