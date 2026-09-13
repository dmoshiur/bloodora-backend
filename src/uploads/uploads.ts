// ==================== In-memory multipart upload helpers ====================
// All uploads land in MEMORY (multer memoryStorage) and are persisted to the
// `uploads` table by uploadService — files never touch the local disk. That
// keeps the backend safe on serverless hosts (Vercel's filesystem is
// ephemeral) and pairs with DB-backed storage (Turso/libSQL).
import type { Request, RequestHandler } from "express";
import multer from "multer";
import { ApiError, randomId } from "../utils/errors.js";

/** Normalized in-memory image ready to be stored by uploadService. */
export type UploadedImage = {
  originalName: string;
  mime: string;
  data: Buffer;
  ext: string;
};

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** Map a MIME type to a file extension (fallback: png). */
export function extFromMime(mime: string | null | undefined): string {
  return EXT_BY_MIME[String(mime || "").toLowerCase()] || "png";
}

/** Stable, unguessable stored filename: `img_<16 hex>.<ext>`. */
export function newFilename(ext: string | null | undefined): string {
  const clean = String(ext || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  return `img_${randomId(8)}.${clean}`;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_req: unknown, file: { mimetype: string }, cb: multer.FileFilterCallback) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) {
      cb(null, true);
      return;
    }
    cb(ApiError.badRequest("Only image files (png, jpg, webp, gif) are allowed.", "NOT_AN_IMAGE"));
  },
});

export { upload };

/** Convert multer errors into the standard ApiError envelope. */
function mapMulterError(err: unknown): Error {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return new ApiError(413, "FILE_TOO_LARGE", "File too large (max 5 MB).");
    }
    if (err.code === "LIMIT_UNEXPECTED_FILE") {
      return ApiError.badRequest("Unexpected file field.", "UNEXPECTED_FILE");
    }
    return ApiError.badRequest(`Upload failed: ${err.message}`, "UPLOAD_ERROR");
  }
  return err as Error;
}

/**
 * Express middleware: accept exactly ONE file in `field`.
 * Multer errors (size limit, non-image, unexpected field) are converted to
 * ApiError before being passed to the central error handler.
 */
export function singleUpload(field: string): RequestHandler {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (err) {
        next(mapMulterError(err));
        return;
      }
      next();
    });
  };
}

/** Convert multer's in-memory file (req.file) into an UploadedImage, or null when absent. */
export function readUpload(req: Request): UploadedImage | null {
  const f = (req as Request & { file?: Express.Multer.File }).file;
  if (!f || !f.buffer) return null;
  return {
    originalName: f.originalname,
    mime: f.mimetype,
    data: Buffer.from(f.buffer),
    ext: extFromMime(f.mimetype),
  };
}
