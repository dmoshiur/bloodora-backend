import { get, all, run } from "../db/query.js";
import { nowIso } from "../utils/time.js";
import type { UserRow } from "../types.js";

export const userRepo = {
  async findById(id: string): Promise<UserRow | null> {
    return get<UserRow>(`SELECT * FROM users WHERE id = ?`, [id]);
  },

  async findByEmail(email: string): Promise<UserRow | null> {
    return get<UserRow>(`SELECT * FROM users WHERE lower(email) = lower(?)`, [email]);
  },

  async findBySessionToken(token: string): Promise<UserRow | null> {
    return get<UserRow>(`SELECT * FROM users WHERE session_token = ?`, [token]);
  },

  async create(row: Omit<UserRow, "created_at">): Promise<void> {
    await run(
      `INSERT INTO users
        (id, name, email, phone, password_hash, is_admin, is_super_admin, role, donation_role,
         blood_group, city, address_holding, division, district, upazila, union_area,
         can_donate, age, date_of_birth, birth_certificate_number,
         bkash_number, nagad_number, upay_number, rocket_number, pathao_number,
         card_last_four, card_type, is_verified, image_file, session_token,
         language, email_verified, notify_email, notify_inapp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id, row.name, row.email, row.phone, row.password_hash,
        row.is_admin, row.is_super_admin, row.role, row.donation_role,
        row.blood_group, row.city, row.address_holding, row.division, row.district, row.upazila, row.union_area,
        row.can_donate, row.age, row.date_of_birth, row.birth_certificate_number,
        row.bkash_number, row.nagad_number, row.upay_number, row.rocket_number, row.pathao_number,
        row.card_last_four, row.card_type, row.is_verified, row.image_file, row.session_token,
        row.language ?? "en", row.email_verified ?? 0, row.notify_email ?? 1, row.notify_inapp ?? 1,
      ],
    );
  },

  // ---------- preferences (v3) ----------

  /** Language + notification channels. Only the fields passed are touched. */
  async setPreferences(
    id: string,
    fields: { language?: string; notify_email?: boolean; notify_inapp?: boolean },
  ): Promise<void> {
    await run(
      `UPDATE users SET
         language = COALESCE(?, language),
         notify_email = COALESCE(?, notify_email),
         notify_inapp = COALESCE(?, notify_inapp)
       WHERE id = ?`,
      [
        fields.language ?? null,
        fields.notify_email === undefined ? null : fields.notify_email ? 1 : 0,
        fields.notify_inapp === undefined ? null : fields.notify_inapp ? 1 : 0,
        id,
      ],
    );
  },

  /** Email ownership verified (distinct from donor verification). */
  async setEmailVerified(id: string, verified: boolean): Promise<void> {
    await run(`UPDATE users SET email_verified = ?, email_verified_at = ? WHERE id = ?`, [
      verified ? 1 : 0,
      verified ? nowIso() : null,
      id,
    ]);
  },

  /** Record a successful authentication (dashboard + security emails). */
  async touchLogin(id: string): Promise<void> {
    await run(`UPDATE users SET last_login_at = ? WHERE id = ?`, [nowIso(), id]);
  },

  /** Paginated, filterable admin listing. Returns rows + the true total. */
  async listPaged(opts: {
    search?: string;
    role?: string;
    status?: "verified" | "unverified" | "donors" | "admins";
    sort?: "created_at" | "name" | "email";
    dir?: "asc" | "desc";
    limit?: number;
    offset?: number;
  } = {}): Promise<{ rows: UserRow[]; total: number }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.search) {
      where.push("(name LIKE ? OR email LIKE ? OR phone LIKE ? OR city LIKE ? OR blood_group LIKE ?)");
      const like = `%${opts.search}%`;
      args.push(like, like, like, like, like);
    }
    if (opts.role && ["user", "admin", "super_admin"].includes(opts.role)) {
      where.push("role = ?");
      args.push(opts.role);
    }
    if (opts.status === "verified") where.push("is_verified = 1");
    if (opts.status === "unverified") where.push("is_verified = 0");
    if (opts.status === "donors") where.push("can_donate = 1 AND is_verified = 1");
    if (opts.status === "admins") where.push("is_admin = 1");

    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const sort = ["created_at", "name", "email"].includes(opts.sort ?? "") ? opts.sort! : "created_at";
    const dir = opts.dir === "asc" ? "ASC" : "DESC";
    const limit = Math.min(200, Math.max(1, opts.limit ?? 25));
    const offset = Math.max(0, opts.offset ?? 0);

    const totalRow = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM users${clause}`, args);
    const rows = await all<UserRow>(
      `SELECT * FROM users${clause} ORDER BY ${sort} ${dir}, id ${dir} LIMIT ? OFFSET ?`,
      [...args, limit, offset],
    );
    return { rows, total: totalRow?.n ?? 0 };
  },

  async updateProfile(
    id: string,
    fields: Partial<
      Pick<
        UserRow,
        | "name"
        | "email"
        | "phone"
        | "blood_group"
        | "city"
        | "image_file"
        | "address_holding"
        | "division"
        | "district"
        | "upazila"
        | "union_area"
        | "donation_role"
        | "age"
        | "date_of_birth"
        | "birth_certificate_number"
      >
    >,
  ): Promise<void> {
    await run(
      `UPDATE users SET
         name = COALESCE(?, name),
         email = COALESCE(?, email),
         phone = COALESCE(?, phone),
         blood_group = COALESCE(?, blood_group),
         city = COALESCE(?, city),
         image_file = COALESCE(?, image_file),
         address_holding = COALESCE(?, address_holding),
         division = COALESCE(?, division),
         district = COALESCE(?, district),
         upazila = COALESCE(?, upazila),
         union_area = COALESCE(?, union_area),
         donation_role = COALESCE(?, donation_role),
         age = COALESCE(?, age),
         date_of_birth = COALESCE(?, date_of_birth),
         birth_certificate_number = COALESCE(?, birth_certificate_number)
       WHERE id = ?`,
      [
        fields.name ?? null, fields.email ?? null, fields.phone ?? null, fields.blood_group ?? null,
        fields.city ?? null, fields.image_file ?? null, fields.address_holding ?? null,
        fields.division ?? null, fields.district ?? null, fields.upazila ?? null,
        fields.union_area ?? null, fields.donation_role ?? null, fields.age ?? null,
        fields.date_of_birth ?? null, fields.birth_certificate_number ?? null, id,
      ],
    );
  },

  /** Explicit set (admin user-edit; the original always writes the form value). */
  async setCanDonate(id: string, canDonate: boolean): Promise<void> {
    await run(`UPDATE users SET can_donate = ? WHERE id = ?`, [canDonate ? 1 : 0, id]);
  },

  async toggleCanDonate(id: string, current: number): Promise<number> {
    const next = current ? 0 : 1;
    await run(
      `UPDATE users SET can_donate = ?, last_donation = CASE WHEN ? = 0 THEN datetime('now') ELSE last_donation END WHERE id = ?`,
      [next, next, id],
    );
    return next;
  },

  async setWallet(
    id: string,
    fields: Partial<
      Pick<UserRow, "bkash_number" | "nagad_number" | "upay_number" | "rocket_number" | "pathao_number" | "card_last_four" | "card_type">
    >,
  ): Promise<void> {
    await run(
      `UPDATE users SET
         bkash_number = COALESCE(?, bkash_number),
         nagad_number = COALESCE(?, nagad_number),
         upay_number = COALESCE(?, upay_number),
         rocket_number = COALESCE(?, rocket_number),
         pathao_number = COALESCE(?, pathao_number),
         card_last_four = COALESCE(?, card_last_four),
         card_type = COALESCE(?, card_type)
       WHERE id = ?`,
      [
        fields.bkash_number ?? null, fields.nagad_number ?? null, fields.upay_number ?? null,
        fields.rocket_number ?? null, fields.pathao_number ?? null, fields.card_last_four ?? null,
        fields.card_type ?? null, id,
      ],
    );
  },

  async setSuperAdmin(id: string, isSuper: boolean, isAdmin: boolean): Promise<void> {
    const role = isSuper ? "super_admin" : isAdmin ? "admin" : "user";
    await run(`UPDATE users SET is_super_admin = ?, is_admin = ?, role = ? WHERE id = ?`, [
      isSuper ? 1 : 0, isAdmin ? 1 : 0, role, id,
    ]);
  },

  async listDonors(
    opts: { bg?: string; dist?: string; upa?: string; ageMin?: number; limit?: number } = {},
  ): Promise<UserRow[]> {
    const where: string[] = ["can_donate = 1", "is_verified = 1", "blood_group IS NOT NULL", "blood_group != ''"];
    const args: unknown[] = [];
    if (opts.bg) {
      where.push("lower(blood_group) = lower(?)");
      args.push(opts.bg);
    }
    if (opts.dist) {
      where.push("lower(district) LIKE lower(?)");
      args.push(`%${opts.dist}%`);
    }
    if (opts.upa) {
      where.push("lower(upazila) LIKE lower(?)");
      args.push(`%${opts.upa}%`);
    }
    if (opts.ageMin && opts.ageMin > 0) {
      where.push("(age IS NULL OR age >= ?)");
      args.push(opts.ageMin);
    }
    const limit = Math.min(200, opts.limit ?? 100);
    return all<UserRow>(
      `SELECT * FROM users WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
      [...args, limit],
    );
  },

  async setPassword(id: string, passwordHash: string): Promise<void> {
    await run(`UPDATE users SET password_hash = ? WHERE id = ?`, [passwordHash, id]);
  },

  async setSessionToken(id: string, token: string | null): Promise<void> {
    await run(`UPDATE users SET session_token = ? WHERE id = ?`, [token, id]);
  },

  async setVerified(id: string, verified: boolean): Promise<void> {
    await run(`UPDATE users SET is_verified = ? WHERE id = ?`, [verified ? 1 : 0, id]);
  },

  async setRole(id: string, role: string, isAdmin: boolean): Promise<void> {
    await run(`UPDATE users SET role = ?, is_admin = ? WHERE id = ?`, [role, isAdmin ? 1 : 0, id]);
  },

  async delete(id: string): Promise<void> {
    await run(`DELETE FROM users WHERE id = ?`, [id]);
  },

  async search(term: string, limit = 50): Promise<UserRow[]> {
    const like = `%${term}%`;
    return all<UserRow>(
      `SELECT * FROM users
       WHERE name LIKE ? OR email LIKE ? OR phone LIKE ? OR city LIKE ? OR blood_group LIKE ?
       ORDER BY created_at DESC LIMIT ?`,
      [like, like, like, like, like, limit],
    );
  },

  async list(limit = 100, offset = 0): Promise<UserRow[]> {
    return all<UserRow>(`SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?`, [limit, offset]);
  },

  async count(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM users`);
    return row?.n ?? 0;
  },

  async countByRole(role: string): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE role = ?`, [role]);
    return row?.n ?? 0;
  },

  async countUnverified(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE is_verified = 0`);
    return row?.n ?? 0;
  },

  async countCreatedAfter(since: string): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`, [since]);
    return row?.n ?? 0;
  },

  /** Verified donors who can donate (original dashboard stat). */
  async countVerifiedDonors(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE can_donate = 1 AND is_verified = 1`);
    return row?.n ?? 0;
  },

  /** Unverified users eligible for verification (18+). */
  async countUnverified18Plus(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE is_verified = 0 AND age >= 18`);
    return row?.n ?? 0;
  },

  async listAll(limit = 1000): Promise<UserRow[]> {
    return all<UserRow>(`SELECT * FROM users ORDER BY created_at DESC LIMIT ?`, [limit]);
  },
};
