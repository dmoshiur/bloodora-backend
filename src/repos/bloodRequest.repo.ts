import { get, all, run } from "../db/query.js";
import type { BloodRequestRow } from "../types.js";

export const bloodRequestRepo = {
  async findById(id: string): Promise<BloodRequestRow | null> {
    return get<BloodRequestRow>(
      `SELECT br.*, u.name AS requester_name
       FROM blood_requests br LEFT JOIN users u ON br.user_id = u.id
       WHERE br.id = ?`,
      [id],
    );
  },

  async create(row: Omit<BloodRequestRow, "created_at">): Promise<void> {
    await run(
      `INSERT INTO blood_requests
        (id, user_id, name, phone, hospital, patient_name, patient_relation, hospital_name,
         hospital_address, contact_person, contact_phone, contact_email, urgent_reason,
         needed_by, additional_info, blood_group, units, quantity, division, district, upazila,
         location_division, location_district, location_upazila, urgent, status, is_fulfilled,
         fulfilled_at, fulfilled_by, note, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)`,
      [
        row.id, row.user_id, row.name, row.phone, row.hospital, row.patient_name, row.patient_relation,
        row.hospital_name, row.hospital_address, row.contact_person, row.contact_phone, row.contact_email,
        row.urgent_reason, row.needed_by, row.additional_info, row.blood_group, row.units, row.quantity,
        row.division, row.district, row.upazila, row.location_division, row.location_district,
        row.location_upazila, row.urgent, row.status, row.note, row.updated_at,
      ],
    );
  },

  /** Public list: open (not fulfilled) and not past needed_by. */
  async listPublic(opts: { group?: string; division?: string; dist?: string; urgent?: boolean; limit?: number } = {}): Promise<BloodRequestRow[]> {
    const where: string[] = ["is_fulfilled = 0", "status != 'cancelled'", "(needed_by IS NULL OR datetime(needed_by) >= datetime('now'))"];
    const args: unknown[] = [];
    if (opts.group) {
      where.push("blood_group = ?");
      args.push(opts.group);
    }
    if (opts.division) {
      where.push("location_division LIKE ?");
      args.push(`%${opts.division}%`);
    }
    if (opts.dist) {
      where.push("location_district LIKE ?");
      args.push(`%${opts.dist}%`);
    }
    if (opts.urgent) {
      where.push("urgent = 1");
    }
    const limit = Math.min(200, opts.limit ?? 100);
    return all<BloodRequestRow>(
      `SELECT br.*, u.name AS requester_name
       FROM blood_requests br LEFT JOIN users u ON br.user_id = u.id
       WHERE ${where.join(" AND ")}
       ORDER BY urgent DESC, datetime(needed_by) ASC LIMIT ?`,
      [...args, limit],
    );
  },

  async listUrgent(limit = 100): Promise<BloodRequestRow[]> {
    return all<BloodRequestRow>(
      `SELECT br.*, u.name AS requester_name
       FROM blood_requests br LEFT JOIN users u ON br.user_id = u.id
       WHERE urgent = 1 AND is_fulfilled = 0 AND status != 'cancelled'
       ORDER BY datetime(needed_by) ASC LIMIT ?`,
      [limit],
    );
  },

  /** Admin/moderation list (all, incl. fulfilled & cancelled). */
  async listAll(opts: { status?: string; group?: string; limit?: number; offset?: number } = {}): Promise<BloodRequestRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    if (opts.group) {
      where.push("blood_group = ?");
      args.push(opts.group);
    }
    const limit = Math.min(200, opts.limit ?? 100);
    const offset = Math.max(0, opts.offset ?? 0);
    return all<BloodRequestRow>(
      `SELECT br.*, u.name AS requester_name
       FROM blood_requests br LEFT JOIN users u ON br.user_id = u.id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
  },

  async fulfill(id: string, byUserId: string): Promise<void> {
    await run(
      `UPDATE blood_requests SET is_fulfilled = 1, status = 'fulfilled', fulfilled_at = datetime('now'), fulfilled_by = ?, updated_at = datetime('now') WHERE id = ?`,
      [byUserId, id],
    );
  },

  async cancel(id: string): Promise<void> {
    await run(
      `UPDATE blood_requests SET status = 'cancelled', is_fulfilled = 1, updated_at = datetime('now') WHERE id = ?`,
      [id],
    );
  },

  async setStatus(id: string, status: string): Promise<void> {
    await run(`UPDATE blood_requests SET status = ?, updated_at = datetime('now') WHERE id = ?`, [status, id]);
  },

  async countByStatus(status: string): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM blood_requests WHERE status = ?`, [status]);
    return row?.n ?? 0;
  },

  async countUrgent(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM blood_requests WHERE urgent = 1 AND is_fulfilled = 0 AND status != 'cancelled'`);
    return row?.n ?? 0;
  },

  async countAll(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM blood_requests`);
    return row?.n ?? 0;
  },

  async countCreatedAfter(since: string): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM blood_requests WHERE created_at >= ?`, [since]);
    return row?.n ?? 0;
  },

  async delete(id: string): Promise<void> {
    await run(`DELETE FROM blood_requests WHERE id = ?`, [id]);
  },
};
