import type { SafeUser, UserRow } from "../types.js";

/**
 * The single place a `users` row becomes a client-safe user object.
 *
 * Two rules, both security-relevant:
 *  1. `password_hash` and `session_token` are STRIPPED — they must never reach a
 *     response body, a session row or a log line;
 *  2. the 0/1 integer flag columns become real booleans, because every EJS view
 *     in the frontend tests them with `if (u.is_admin)` (and `if (0)` is falsy
 *     while `if ("0")` would not be).
 *
 * `role` here is the ACCOUNT role (`user` | `admin` | `super_admin`). The admin
 * dashboard deliberately reports `role: donation_role` for its user table — that
 * mapping lives in `adminService.userView` and is kept separate on purpose.
 */
export function toSafeUser(row: UserRow): SafeUser {
  const {
    password_hash: _password,
    session_token: _session,
    ...safe
  } = row as unknown as Record<string, unknown> & { password_hash?: string; session_token?: string };

  return {
    ...safe,
    is_admin: Boolean(safe.is_admin),
    is_super_admin: Boolean(safe.is_super_admin),
    is_verified: Boolean(safe.is_verified),
    can_donate: Boolean(safe.can_donate),
    email_verified: Boolean(safe.email_verified),
    notify_email: safe.notify_email === undefined ? true : Boolean(safe.notify_email),
    notify_inapp: safe.notify_inapp === undefined ? true : Boolean(safe.notify_inapp),
    language: typeof safe.language === "string" && safe.language ? safe.language : "en",
  } as unknown as SafeUser;
}
