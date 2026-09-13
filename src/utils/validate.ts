import { ZodError } from "zod";
import { ApiError } from "./errors.js";
import { translate } from "../i18n/index.js";

/**
 * Parse `value` against a zod schema, converting validation failures into a
 * single 400 VALIDATION_ERROR with a flat list of issues.
 *
 * The human-readable `message` is localized; `code` and every `field` name stay
 * machine-readable (they are identifiers, never prose).
 */
export function parse<T>(schema: { parse: (v: unknown) => T }, value: unknown, lang?: string | null): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({
        field: i.path.join(".") || "(root)",
        message: i.message,
        code: i.code,
      }));
      throw ApiError.badRequest(translate(lang, "validation.failed"), "VALIDATION_ERROR", { issues });
    }
    throw err;
  }
}

const TRUTHY = new Set(["1", "true", "yes", "y", "on", "enabled"]);
const FALSY = new Set(["0", "false", "no", "n", "off", "disabled", ""]);

/**
 * Coerce the many shapes a boolean arrives in.
 *
 * HTML checkboxes post `on` when ticked and omit the field entirely when not,
 * JSON clients post `true`/`false`, and query strings post `"1"`/`"0"`. The old
 * `Boolean(body.is_admin)` was wrong for two of those three: `Boolean("0")`,
 * `Boolean("false")` and `Boolean("off")` are all `true`, so an admin edit that
 * meant to REMOVE a flag could silently grant it instead.
 */
export function toBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) && v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (TRUTHY.has(s)) return true;
    if (FALSY.has(s)) return false;
    return fallback;
  }
  return fallback;
}

/** Clamp an integer into [min, max] (pagination, limits, ratings…). */
export function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = intv(v);
  if (n === undefined) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Normalize unknown input into a string, trimming it; empty → undefined. */
export function str(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

/** Normalize into an int (or undefined when absent/invalid). */
export function intv(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
}

/** Normalize into a non-negative int. */
export function uintv(v: unknown): number | undefined {
  const n = intv(v);
  return n !== undefined && n >= 0 ? n : undefined;
}

/** True for `null`, `""`, arrays without length, objects with no keys. */
export function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}
