import crypto from "node:crypto";

/** Structured HTTP error with a machine-readable `code` (API_* or *_ERROR). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message = "Bad request", code = "BAD_REQUEST", details?: unknown) {
    return new ApiError(400, code, message, details);
  }
  static unauthorized(message = "Authentication required", code = "UNAUTHENTICATED") {
    return new ApiError(401, code, message);
  }
  static forbidden(message = "Forbidden", code = "FORBIDDEN") {
    return new ApiError(403, code, message);
  }
  static notFound(message = "Not found", code = "NOT_FOUND") {
    return new ApiError(404, code, message);
  }
  static conflict(message = "Conflict", code = "CONFLICT") {
    return new ApiError(409, code, message);
  }
  static unprocessable(message = "Unprocessable entity", code = "UNPROCESSABLE", details?: unknown) {
    return new ApiError(422, code, message, details);
  }
  static tooMany(message = "Too many requests", code = "RATE_LIMITED") {
    return new ApiError(429, code, message);
  }
  static internal(message = "Internal server error", code = "INTERNAL", details?: unknown) {
    return new ApiError(500, code, message, details);
  }
}

export function randomId(bytes = 18): string {
  return crypto.randomBytes(bytes).toString("hex").slice(0, bytes * 2);
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 2) return email;
  return `${email[0]}***${email.slice(at)}`;
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return phone;
  return `${digits.slice(0, 4)}-****-${digits.slice(-2)}`;
}
