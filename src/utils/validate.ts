import { ZodError } from "zod";
import { ApiError } from "./errors.js";

/**
 * Parse `value` against a zod schema, converting validation failures into a
 * single 400 BAD_REQUEST with a flat list of issues.
 */
export function parse<T>(schema: { parse: (v: unknown) => T }, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({
        field: i.path.join(".") || "(root)",
        message: i.message,
        code: i.code,
      }));
      throw ApiError.badRequest(
        "Validation failed",
        "VALIDATION_ERROR",
        { issues, },
      );
    }
    throw err;
  }
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
