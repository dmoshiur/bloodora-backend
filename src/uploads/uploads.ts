/**
 * Multipart upload plumbing (multer + in-memory storage) shared by every route
 * that accepts an image: auth profile pictures, shop product images, admin
 * branding (logo/favicon) and the generic `POST /api/uploads`.
 *
 * WHY MEMORY + DATABASE, NEVER DISK
 * ---------------------------------
 * The app runs as Vercel Functions: the filesystem is read-only outside /tmp,
 * a file written by one instance is invisible to the next, and everything is
 * wiped on cold start. So multer buffers bytes in memory and
 * `uploadService.store()` persists them into the `uploads` table (Turso);
 * `GET /uploads/:file` + `GET /api/uploads/:file` (upload.controller.ts) read
 * them back. The root-level `uploads/` folder in this repo is scratch space for
 * `npm run make-defaults` only — nothing on the request path touches it.
 *
 * NOTE: this directory must stay tracked. `.gitignore` anchors the scratch
 * folder (`/uploads/*`); an unanchored `uploads/` also ignores `src/uploads/`,
 * which silently breaks `npm run build` on any fresh clone (Vercel included).
 */
import crypto from "node:crypto";
import multer from "multer";
import type { Request, RequestHandler } from "express";
import { config } from "../config/env.js";
import { ApiError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

/** A decoded, in-memory image — the shape `uploadService.store()` persists. */
export interface UploadedImage {
  /** Client-supplied file name. Metadata only: never used to build a path. */
  originalName: string;
  /** Normalized MIME type of the upload. */
  mime: string;
  /** Raw bytes. */
  data: Uint8Array;
  /** Extension without the dot; empty/absent when it cannot be determined. */
  ext?: string;
  /** Form field the file arrived on (multi-field routes read this directly). */
  field?: string;
}

const MB = 1024 * 1024;

/** Branding posts logo + favicon together; nothing else sends more than one. */
const MAX_FILES_PER_REQUEST = 4;

/** MIME → extension for the image types the app stores. */
const MIME_EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

/** Extensions may end up in a public URL: letters/digits only, ≤ 8 chars. */
const SAFE_EXT = /^[a-z0-9]{1,8}$/;

function normalizeMime(mime: string): string {
  return String(mime ?? "").split(";")[0].trim().toLowerCase();
}

function sanitizeExt(ext: string): string {
  const e = String(ext ?? "").replace(/^\.+/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return SAFE_EXT.test(e) ? e : "";
}

/** Extension (no dot) for a MIME type; "" when it is not a recognized image. */
export function extFromMime(mime: string): string {
  const key = normalizeMime(mime);
  const known = MIME_EXT[key];
  if (known) return known;
  if (key.startsWith("image/")) {
    // Unlisted but clearly-image subtype: fall back to the subtype label
    // ("image/apng" → "apng") instead of dropping the extension entirely.
    const sub = key.slice("image/".length).replace(/\+.*$/, "").replace(/[^a-z0-9]/g, "");
    if (SAFE_EXT.test(sub)) return sub;
  }
  return "";
}

/** Extension (no dot) taken from a client file name; "" when unusable. */
export function extFromName(name: string): string {
  const base = String(name ?? "").toLowerCase();
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "";
  return sanitizeExt(base.slice(dot + 1));
}

/**
 * Storage name for an upload: random hex + extension.
 *
 * The client's file name is never reused — it is attacker-controlled (path
 * separators, NUL bytes, `.php`, 200-char names) and this value becomes a
 * public URL under `/uploads/`. Random names also make stored files unguessable
 * and keep `ON CONFLICT(filename)` from clobbering an unrelated image.
 */
export function newFilename(ext = ""): string {
  const safe = sanitizeExt(ext);
  return `${crypto.randomBytes(16).toString("hex")}${safe ? `.${safe}` : ""}`;
}

/** Strip directories/control chars from a client file name; cap its length. */
function sanitizeName(name: string): string {
  const base = String(name ?? "").replace(/\\/g, "/").split("/").pop() ?? "";
  return base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 180);
}

/**
 * Accept images only. Every stored row is an image (profile pictures, product
 * photos, logo, favicon) and `serveUpload` hands bytes back with their own
 * stored MIME type, so a non-image upload would be an execution primitive on
 * the API origin. SVG is allowed (logos/favicons use it) but served sandboxed —
 * see `serveUpload`.
 */
function imageOnly(_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback): void {
  const mime = normalizeMime(file.mimetype);
  if (mime.startsWith("image/") && extFromMime(mime)) {
    cb(null, true);
    return;
  }
  logger.warn("upload: rejected non-image", { field: file.fieldname, mime, name: file.originalname });
  cb(ApiError.badRequest(`Only image files are accepted (received ${mime || "an unknown type"})`, "UPLOAD_ERROR"));
}

interface MulterOptions extends multer.Options {
  /**
   * busboy charset for multipart header params. multer defaults to `latin1`,
   * which mojibakes every non-ASCII file name AND text value — the register
   * form is multipart and routinely carries Bangla names. Browsers always send
   * UTF-8. (Not in @types/multer yet, hence the local extension.)
   */
  defParamCharset?: "utf8" | "latin1" | "ascii";
}

/** One multer instance per file-count policy; all uploads stay in memory. */
function makeUploader(maxFiles: number): multer.Multer {
  const options: MulterOptions = {
    storage: multer.memoryStorage(),
    defParamCharset: "utf8",
    fileFilter: imageOnly,
    limits: {
      // Kept under Vercel's 4.5 MB request-body cap so an oversized image is
      // answered by OUR handler (400 UPLOAD_ERROR JSON) rather than by the
      // platform's opaque 413 page. Override with MAX_UPLOAD_MB.
      fileSize: config.maxUploadMb * MB,
      files: maxFiles,
      fields: 64,
      parts: 80,
      fieldNameSize: 200,
      fieldSize: 1 * MB,
      headerPairs: 2000,
    },
  };
  return multer(options);
}

const multi = makeUploader(MAX_FILES_PER_REQUEST);
const single = makeUploader(1);

/**
 * Translate a failed parse into the documented `400 UPLOAD_ERROR` envelope.
 * `MulterError` carries a `code` but no HTTP `status`, so without this the
 * central error handler answers `500 INTERNAL` for what is always a client
 * mistake (file too big, too many files, unexpected field…). Anything that is
 * NOT a multer/ApiError is passed through untouched so real bugs still surface
 * as a logged 500.
 */
function toApiError(err: unknown, field?: string): unknown {
  if (!err) return err;
  if (err instanceof ApiError) return err;

  const isMulterError = err instanceof multer.MulterError || (err as { name?: string }).name === "MulterError";
  if (!isMulterError) return err;

  const code = String((err as { code?: string }).code ?? "");
  const messages: Record<string, string> = {
    LIMIT_FILE_SIZE: `Image is too large (max ${config.maxUploadMb} MB)`,
    LIMIT_FILE_COUNT: "Too many files in this upload",
    LIMIT_PART_COUNT: "Too many parts in this upload",
    LIMIT_FIELD_COUNT: "Too many form fields in this upload",
    LIMIT_FIELD_KEY: "Form field name is too long",
    LIMIT_FIELD_VALUE: "Form field value is too long",
    LIMIT_FIELD_NESTING: "Form field name is nested too deeply",
    LIMIT_FIELD_ARRAY_INDEX: "Form field array index is too large",
    MISSING_FIELD_NAME: "Upload field name is missing",
    LIMIT_UNEXPECTED_FILE: field ? `Unexpected upload field (this endpoint expects "${field}")` : "Unexpected upload field",
  };
  const message = messages[code] ?? "Could not read the upload";
  logger.warn("upload: rejected", { code, field, message });
  return ApiError.badRequest(message, "UPLOAD_ERROR");
}

/** Wrap a multer middleware so its failures reach `toApiError`. */
function guard(handler: RequestHandler, field?: string): RequestHandler {
  return (req, res, next) => {
    handler(req, res, (err?: unknown) => next(toApiError(err, field)));
  };
}

/** The multer surface routes use, with error mapping already applied. */
export interface Uploader {
  /** Exactly one file, on the named field. */
  single(field: string): RequestHandler;
  /** Up to `maxCount` files, all on the named field. */
  array(field: string, maxCount?: number): RequestHandler;
  /** Several named fields at once (e.g. logo + favicon). */
  fields(fields: Array<{ name: string; maxCount?: number }>): RequestHandler;
  /** Any field names, subject to the instance's file limit. */
  any(): RequestHandler;
  /** Text-only multipart (rejects any file). */
  none(): RequestHandler;
}

/**
 * Shared uploader for multi-field routes, e.g. admin branding:
 * `upload.fields([{ name: "logo", maxCount: 1 }, { name: "favicon", maxCount: 1 }])`.
 */
export const upload: Uploader = {
  single: (field) => guard(multi.single(field), field),
  array: (field, maxCount) => guard(multi.array(field, maxCount), field),
  fields: (fields) => guard(multi.fields(fields), fields.map((f) => f.name).join(" or ")),
  any: () => guard(multi.any()),
  none: () => guard(multi.none()),
};

/** Field each in-flight request declared via `singleUpload` (for readUpload). */
const declaredField = new WeakMap<object, string>();

/**
 * Middleware for routes that accept exactly ONE image.
 *
 * `field` is the name the route documents and the one `readUpload(req)` prefers,
 * but parsing is deliberately field-agnostic (`any()` with a one-file limit):
 * every consumer reads the file through `readUpload(req)` without naming a
 * field, and a strict `single(name)` would turn a cosmetic mismatch — a client
 * posting `image` where the route says `profile_pic` — into a
 * LIMIT_UNEXPECTED_FILE rejection instead of a successful upload.
 */
export function singleUpload(field = "file"): RequestHandler {
  const parse = guard(single.any(), field);
  return (req, res, next) => {
    declaredField.set(req, field);
    parse(req, res, next);
  };
}

/** Every usable file on the request, whatever multer shape produced it. */
function collectFiles(req: Request): Express.Multer.File[] {
  let files: Express.Multer.File[] = [];
  if (req.file) files = [req.file];
  else if (Array.isArray(req.files)) files = req.files; // any() / array()
  else if (req.files) files = Object.values(req.files).flat(); // fields()
  // A 0-byte part (an untouched `<input type=file>` still reaches us as an
  // empty filename + empty body) means "no image", not "an empty image": drop
  // it so callers answer their own 400 NO_FILE / NO_IMAGE and no empty row is
  // written to the uploads table.
  return files.filter((f) => (f.buffer?.length ?? 0) > 0);
}

/**
 * The image attached to a request, or `null` when there is none. Handles every
 * multer shape (`single` → `req.file`, `any`/`array` → `File[]`, `fields` →
 * `{ [field]: File[] }`) and prefers `field` — or the field the route declared
 * via `singleUpload` — when several arrived.
 */
export function readUpload(req: Request, field?: string): UploadedImage | null {
  const files = collectFiles(req);
  if (files.length === 0) return null;
  const want = field ?? declaredField.get(req);
  const file = (want ? files.find((f) => f.fieldname === want) : undefined) ?? files[0];
  return toUploadedImage(file);
}

/** Every image attached to a request (rare — routes here take one file each). */
export function readUploads(req: Request): UploadedImage[] {
  return collectFiles(req).map(toUploadedImage);
}

function toUploadedImage(file: Express.Multer.File): UploadedImage {
  const originalName = sanitizeName(file.originalname);
  const mime = normalizeMime(file.mimetype) || "application/octet-stream";
  return {
    field: file.fieldname,
    originalName,
    mime,
    // Copy: the buffer belongs to the request lifecycle, while the row is
    // written to the DB after the multipart stream has already finished.
    data: Buffer.from(file.buffer ?? Buffer.alloc(0)),
    ext: extFromMime(mime) || extFromName(originalName),
  };
}
