/**
 * Timestamp helpers.
 *
 * Two timestamp formats live in this database:
 *
 *   1. SQLite's `datetime('now')` default → `2026-09-13 06:49:18`  (UTC, no marker)
 *   2. JavaScript's `toISOString()`      → `2026-09-13T06:49:18.894Z`
 *
 * Format 1 is what every `created_at DEFAULT (datetime('now'))` column produces
 * and what the frontend templates slice (`created_at.slice(0, 10)`), so it must
 * keep working. Format 2 is what the application writes explicitly.
 *
 * Comparing the two as strings is ALWAYS false, because `' '` (0x20) sorts
 * before `'T'` (0x54):
 *
 *     '2026-09-13 06:49:18' > '2026-09-13T06:49:18.894Z'   → false
 *
 * That single mismatch silently killed both realtime channels — the public
 * activity stream (`GET /api/meta/activity/stream`) and the admin live-chat
 * stream (`GET /api/support/admin/stream`) filtered rows with a string
 * comparison against an ISO cursor and therefore never emitted an event.
 * Everything that compares time now goes through `toEpochMs()`.
 */

/** Current time as ISO-8601 UTC. Use for every row the app writes itself. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Parse either stored format into epoch milliseconds.
 *
 * `2026-09-13 06:49:18` has no zone marker: SQLite's `datetime('now')` is UTC,
 * but `new Date("2026-09-13 06:49:18")` would read it as *local* time, shifting
 * every comparison by the host offset. Append `Z` before parsing.
 */
export function toEpochMs(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  // Already epoch milliseconds (some columns store numbers).
  if (/^\d{12,}$/.test(raw)) return Number(raw);
  const normalized = raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? 0 : ms;
}

/** True when `value` is at or after `cursor` (both in any supported format). */
export function isAtOrAfter(value: string | null | undefined, cursor: string | number): boolean {
  return toEpochMs(value) >= toEpochMs(cursor);
}

/** True when `value` is strictly after `cursor`. */
export function isAfter(value: string | null | undefined, cursor: string | number): boolean {
  return toEpochMs(value) > toEpochMs(cursor);
}

/** Normalize any stored timestamp to ISO-8601 UTC (safe for JSON responses). */
export function toIso(value: string | null | undefined): string | null {
  const ms = toEpochMs(value);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

/** Milliseconds from now → ISO-8601 UTC (token expiry, window ends). */
export function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}
