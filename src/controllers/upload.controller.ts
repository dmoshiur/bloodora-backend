import type { Request, Response } from "express";
import { str } from "../utils/validate.js";
import { ApiError } from "../utils/errors.js";
import { uploadService } from "../services/upload.service.js";
import { settingsService } from "../services/settings.service.js";
import { readUpload, singleUpload } from "../uploads/uploads.js";
import { logger } from "../utils/logger.js";

export const uploadFile = singleUpload("file");

/** POST /api/uploads — auth: generic image upload; returns a stable URL. */
export async function upload(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized("Login required to upload", "LOGIN_REQUIRED");
  const file = readUpload(req);
  if (!file) throw ApiError.badRequest("No file uploaded (field name: file)", "NO_FILE");
  const filename = await uploadService.store(file);
  res.status(201).json({ filename, url: `/uploads/${filename}`, size: file.data.length });
}

/**
 * GET /uploads/:file — serve stored images from the database.
 * Mounted at the APP ROOT (not under /api) because the frontend references
 * /uploads/... URLs directly; /api/uploads is aliased to the same handler.
 */
export async function serveUpload(req: Request, res: Response): Promise<void> {
  const filename = str(req.params.file);
  if (!filename) throw ApiError.badRequest("Filename is required", "FILENAME_REQUIRED");
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    throw ApiError.badRequest("Invalid filename", "BAD_FILENAME");
  }
  const row = await uploadService.read(filename);
  if (!row) {
    logger.debug("upload: miss", { filename });
    res.status(404).json({ error: { code: "NOT_FOUND", message: "File not found" } });
    return;
  }
  // libSQL returns BLOBs as ArrayBuffer on the local sqlite3 driver and as
  // Uint8Array on the WASM/Turso driver — normalize before sizing the body.
  // (ArrayBuffer has byteLength, not length; String(undefined) would emit an
  // invalid Content-Length header and break every image load.)
  const data = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
  res.setHeader("Content-Type", row.mime);
  res.setHeader("Content-Length", String(data.byteLength));
  res.setHeader("Cache-Control", "public, max-age=86400, immutable");
  res.end(Buffer.from(data));
}

export const uploadLogo = singleUpload("logo");

/** POST /api/admin/settings/logo — admin: replace the site logo. */
export async function replaceLogo(req: Request, res: Response): Promise<void> {
  if (!req.user) throw ApiError.unauthorized();
  const file = readUpload(req);
  if (!file) throw ApiError.badRequest("No logo uploaded (field name: logo)", "NO_FILE");
  const filename = await uploadService.store(file);
  const settings = await settingsService.replaceLogo(req.user, filename);
  res.json({ settings });
}
