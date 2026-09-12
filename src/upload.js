// ==================== BloodOra Backend - File Uploads ====================
// Multer image uploads. On Vercel the filesystem is read-only except /tmp,
// so uploads are stored in /tmp/uploads there (ephemeral, same trade-off the
// monolith had). For permanent image storage, plug in Turso/R2/S3 later.
import multer from "multer";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const UPLOAD_DIR = process.env.VERCEL
  ? "/tmp/uploads"
  : path.join(__dirname, "../uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
    cb(null, new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "_" + crypto.randomBytes(4).toString("hex") + ext);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_UPLOAD_SIZE || String(16 * 1024 * 1024), 10) },
  fileFilter: (req, file, cb) => {
    if (["image/jpeg", "image/png", "image/jpg", "image/gif", "image/webp"].includes(file.mimetype)) cb(null, true);
    else cb(new Error("Only image files (jpg/png/gif/webp) are allowed."));
  },
});
