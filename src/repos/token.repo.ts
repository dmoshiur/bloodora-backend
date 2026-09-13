import crypto from "node:crypto";
import { all, get, run } from "../db/query.js";
import { isoIn, nowIso, toEpochMs } from "../utils/time.js";
import { randomId } from "../utils/errors.js";

/**
 * Single-use authentication tokens (password reset, email verification).
 *
 * Security properties:
 *  - only the SHA-256 hash of the token is stored, so a database read cannot be
 *    replayed as a reset link;
 *  - tokens are 32 url-safe random bytes (256 bits of entropy);
 *  - expiry is short (reset: 30 min, verify: 48 h) and checked with epoch maths,
 *    not string comparison;
 *  - consumption is a CONDITIONAL update (`consumed_at IS NULL`), so two
 *    concurrent submissions of the same link cannot both succeed;
 *  - issuing a new token for the same (user, purpose) revokes the previous ones,
 *    so only the most recent email link works.
 */

export type TokenPurpose = "password_reset" | "email_verify";

export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  password_reset: 30 * 60 * 1000,
  email_verify: 48 * 60 * 60 * 1000,
};

export interface AuthTokenRow {
  id: string;
  user_id: string;
  purpose: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  ip: string | null;
  created_at: string;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export const tokenRepo = {
  /** Issue a token, revoking any outstanding token for the same purpose. */
  async issue(userId: string, purpose: TokenPurpose, ip?: string | null): Promise<{ token: string; expiresAt: string }> {
    const token = newToken();
    const expiresAt = isoIn(TOKEN_TTL_MS[purpose]);
    await run(`UPDATE auth_tokens SET consumed_at = ? WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL`, [
      nowIso(),
      userId,
      purpose,
    ]);
    await run(
      `INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomId(), userId, purpose, hashToken(token), expiresAt, ip ?? null, nowIso()],
    );
    return { token, expiresAt };
  },

  /** Look up an unconsumed, unexpired token. Returns null when unusable. */
  async findValid(token: string, purpose: TokenPurpose): Promise<AuthTokenRow | null> {
    const row = await get<AuthTokenRow>(
      `SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ? AND consumed_at IS NULL`,
      [hashToken(token), purpose],
    );
    if (!row) return null;
    if (toEpochMs(row.expires_at) <= Date.now()) return null;
    return row;
  },

  /** Atomically consume a token. False when it was already used/expired. */
  async consume(id: string): Promise<boolean> {
    const { changes } = await run(`UPDATE auth_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL`, [
      nowIso(),
      id,
    ]);
    return changes > 0;
  },

  async revokeAllForUser(userId: string): Promise<number> {
    const { changes } = await run(`UPDATE auth_tokens SET consumed_at = ? WHERE user_id = ? AND consumed_at IS NULL`, [
      nowIso(),
      userId,
    ]);
    return changes;
  },

  async countIssuedSince(userId: string, purpose: TokenPurpose, sinceIso: string): Promise<number> {
    const row = await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND purpose = ? AND created_at >= ?`,
      [userId, purpose, sinceIso],
    );
    return row?.n ?? 0;
  },

  async purgeExpired(): Promise<number> {
    const { changes } = await run(`DELETE FROM auth_tokens WHERE expires_at < ? OR consumed_at IS NOT NULL`, [nowIso()]);
    return changes;
  },

  async listForUser(userId: string): Promise<AuthTokenRow[]> {
    return all<AuthTokenRow>(`SELECT * FROM auth_tokens WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, [userId]);
  },
};
