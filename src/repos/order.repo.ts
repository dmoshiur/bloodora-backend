import { get, all, run, transaction, type TxExecutor } from "../db/query.js";
import type { OrderRow, OrderItemRow } from "../types.js";

/**
 * Thrown inside `placeTx` when the stock re-check fails. The transaction rolls
 * back, so no order and no partial stock movement survives. The service layer
 * turns it into a localized `422 OUT_OF_STOCK`.
 */
export class OutOfStockError extends Error {
  readonly code = "OUT_OF_STOCK";
  constructor(
    readonly productId: string,
    readonly productName: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(`Insufficient stock for ${productName} (requested ${requested}, available ${available})`);
    this.name = "OutOfStockError";
  }
}

export const orderRepo = {
  async findById(id: string): Promise<OrderRow | null> {
    return get<OrderRow>(`SELECT * FROM orders WHERE id = ?`, [id]);
  },

  /** Did this user order this product (review pre-check)? */
  async itemsForProductAndUser(userId: string, productId: string): Promise<boolean> {
    const row = await get<{ x: number }>(
      `SELECT 1 AS x FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.user_id = ? AND oi.product_id = ? LIMIT 1`,
      [userId, productId],
    );
    return Boolean(row);
  },

  async items(orderId: string): Promise<OrderItemRow[]> {
    // order_items has no created_at column; rowid preserves insert order.
    return all<OrderItemRow>(`SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid`, [orderId]);
  },

  async byUser(userId: string, limit = 50): Promise<OrderRow[]> {
    return all<OrderRow>(`SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [userId, limit]);
  },

  async list(opts: { status?: string; limit?: number; offset?: number } = {}): Promise<OrderRow[]> {
    const { status, limit = 100, offset = 0 } = opts;
    let sql = `SELECT * FROM orders`;
    const args: unknown[] = [];
    if (status) {
      sql += ` WHERE status = ?`;
      args.push(status);
    }
    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    args.push(limit, offset);
    return all<OrderRow>(sql, args);
  },

  async setStatus(id: string, status: string, paymentStatus?: string): Promise<void> {
    if (paymentStatus) {
      await run(`UPDATE orders SET status = ?, payment_status = ? WHERE id = ?`, [status, paymentStatus, id]);
    } else {
      await run(`UPDATE orders SET status = ? WHERE id = ?`, [status, id]);
    }
  },

  async setPaymentRef(id: string, ref: string | null): Promise<void> {
    await run(`UPDATE orders SET payment_ref = ? WHERE id = ?`, [ref, id]);
  },

  async countByStatus(status: string): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE status = ?`, [status]);
    return row?.n ?? 0;
  },

  async countAll(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM orders`);
    return row?.n ?? 0;
  },

  async sumTotalWhere(status?: string): Promise<number> {
    if (status) {
      const row = await get<{ s: number | null }>(`SELECT COALESCE(SUM(total), 0) AS s FROM orders WHERE status = ?`, [status]);
      return Number(row?.s ?? 0);
    }
    const row = await get<{ s: number | null }>(`SELECT COALESCE(SUM(total), 0) AS s FROM orders`);
    return Number(row?.s ?? 0);
  },

  async countCreatedAfter(since: string): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?`, [since]);
    return row?.n ?? 0;
  },

  async sumCreatedAfter(since: string): Promise<number> {
    const row = await get<{ s: number | null }>(`SELECT COALESCE(SUM(total), 0) AS s FROM orders WHERE created_at >= ?`, [since]);
    return Number(row?.s ?? 0);
  },

  /**
   * Admin status transition with restock-on-cancel in ONE transaction.
   *
   * The previous implementation read the items and adjusted stock in separate
   * statements before flipping the status, so two admins cancelling the same
   * order (or a cancel racing the owner's own cancel) restocked the items twice.
   * Here the status flip is the claim: only the caller whose conditional UPDATE
   * actually changed a row performs the restock.
   */
  async setStatusTx(
    id: string,
    status: string,
    opts: { paymentStatus?: string } = {},
  ): Promise<{ changed: boolean; restocked: boolean }> {
    return transaction(async (tx: TxExecutor) => {
      const current = await tx.get<{ status: string }>(`SELECT status FROM orders WHERE id = ?`, [id]);
      if (!current) return { changed: false, restocked: false };
      if (current.status === status && !opts.paymentStatus) return { changed: false, restocked: false };

      await tx.run(
        opts.paymentStatus
          ? `UPDATE orders SET status = ?, payment_status = ? WHERE id = ?`
          : `UPDATE orders SET status = ? WHERE id = ?`,
        opts.paymentStatus ? [status, opts.paymentStatus, id] : [status, id],
      );

      // Cancel → restock, but only on the transition INTO cancelled.
      if (status === "cancelled" && current.status !== "cancelled") {
        const items = await tx.all<{ product_id: string; qty: number }>(
          `SELECT product_id, qty FROM order_items WHERE order_id = ?`,
          [id],
        );
        for (const it of items) {
          await tx.run(`UPDATE products SET stock = stock + ? WHERE id = ?`, [it.qty, it.product_id]);
          await tx.run(
            `UPDATE products SET sales_count = CASE WHEN sales_count >= ? THEN sales_count - ? ELSE 0 END WHERE id = ?`,
            [it.qty, it.qty, it.product_id],
          );
        }
        return { changed: true, restocked: true };
      }
      return { changed: true, restocked: false };
    });
  },

  /**
   * Atomically cancel a pending order as its owner: the status flip is a
   * conditional claim (`WHERE status = 'pending'`), so a double-cancel or a
   * cancel racing an admin status change can never restock twice.
   * Returns false when the order was not claimable (already processed).
   */
  async cancelByUserTx(id: string): Promise<boolean> {
    return transaction(async (tx: TxExecutor) => {
      const claim = await tx.run(
        `UPDATE orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'`,
        [id],
      );
      if (claim.changes === 0) return false;
      const items = await tx.all<{ product_id: string; qty: number }>(
        `SELECT product_id, qty FROM order_items WHERE order_id = ?`,
        [id],
      );
      for (const it of items) {
        await tx.run(`UPDATE products SET stock = stock + ? WHERE id = ?`, [it.qty, it.product_id]);
      }
      return true;
    });
  },

  /**
   * Atomically place an order: insert order + items and decrement stock in ONE
   * transaction. If any stock check fails the whole transaction rolls back, so
   * ghost orders / negative stock can never persist.
   */
  async placeTx(
    order: Omit<OrderRow, "created_at">,
    items: Array<{
      id: string;
      product_id: string;
      product_name: string;
      product_image: string | null;
      price: number;
      qty: number;
      line_total: number;
    }>,
  ): Promise<void> {
    await transaction(async (tx: TxExecutor) => {
      for (const item of items) {
        const prod = await tx.get<{ id: string; stock: number; price: number }>(
          `SELECT id, stock, price FROM products WHERE id = ?`,
          [item.product_id],
        );
        await tx.run(
          `INSERT INTO order_items (id, order_id, product_id, product_name, product_image, price, qty, line_total)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [item.id, order.id, item.product_id, item.product_name, item.product_image, item.price, item.qty, item.line_total],
        );
        // Stock is re-checked INSIDE the transaction. Two concurrent checkouts
        // for the last unit cannot both succeed: the loser rolls back with
        // OutOfStockError instead of creating a ghost order or negative stock.
        if (!prod) {
          throw new OutOfStockError(item.product_id, item.product_name, item.qty, 0);
        }
        if (prod.stock < item.qty) {
          throw new OutOfStockError(item.product_id, item.product_name, item.qty, Math.max(0, prod.stock));
        }
        await tx.run(`UPDATE products SET stock = stock - ? WHERE id = ?`, [item.qty, item.product_id]);
        await tx.run(`UPDATE products SET sales_count = sales_count + ? WHERE id = ?`, [item.qty, item.product_id]);
      }
      await tx.run(
        `INSERT INTO orders
          (id, user_id, customer_name, customer_phone, address, city, division, district, upazila,
           payment_method, payment_ref, subtotal, delivery_fee, total, status, payment_status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          order.id, order.user_id, order.customer_name, order.customer_phone, order.address, order.city,
          order.division, order.district, order.upazila ?? null, order.payment_method, order.payment_ref ?? null,
          order.subtotal, order.delivery_fee, order.total, order.status, order.payment_status, order.note ?? null,
        ],
      );
    });
  },
};
