import { uploadRepo } from "../repos/upload.repo.js";
import { randomId } from "../utils/errors.js";
import { extFromMime, newFilename, type UploadedImage } from "../uploads/uploads.js";
import { logger } from "../utils/logger.js";

export const uploadService = {
  /** Persist an in-memory upload into the uploads table; returns the stored filename. */
  async store(img: UploadedImage): Promise<string> {
    const filename = newFilename(img.ext || extFromMime(img.mime));
    await uploadRepo.insert(randomId(), filename, img.originalName, img.mime, img.data);
    logger.info("upload: stored", { filename, bytes: img.data.length });
    return filename;
  },

  async read(filename: string): Promise<{ mime: string; data: Uint8Array } | null> {
    const row = await uploadRepo.findByFilename(filename);
    if (!row) return null;
    // Driver-dependent BLOB type: ArrayBuffer (local sqlite3) vs Uint8Array
    // (WASM/Turso). Normalize to the promised Uint8Array.
    const data = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data as ArrayBuffer);
    return { mime: row.mime, data };
  },

  async remove(filename: string): Promise<void> {
    await uploadRepo.delete(filename);
  },
};
