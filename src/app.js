// ==================== BloodOra Backend - Express App Factory ====================
// Standalone REST API. Hosted on its OWN Vercel project/account.
// The frontend project talks to this API over HTTPS; the only link between
// the two deployments is environment variables:
//   - here:     FRONTEND_URL  (CORS allow-list, the frontend's Vercel URL)
//   - frontend: BACKEND_URL   (this API's Vercel URL)
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

import { initDB } from "./db.js";
import { UPLOAD_DIR } from "./upload.js";

import authRoutes from "./routes/auth.js";
import metaRoutes from "./routes/meta.js";
import userRoutes from "./routes/users.js";
import bloodRoutes from "./routes/blood.js";
import shopRoutes from "./routes/shop.js";
import messageRoutes from "./routes/messages.js";
import adminRoutes from "./routes/admin.js";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);

// ---------- CORS from FRONTEND_URL env ----------
const allowedOrigins = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Non-browser clients (curl, the frontend server itself) send no Origin header
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, true); // dev convenience
    const clean = origin.replace(/\/+$/, "");
    if (allowedOrigins.includes(clean)) return callback(null, true);
    // Local development of the frontend is always allowed (never affects prod,
    // browsers send no localhost Origin from production deployments)
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(clean)) return callback(null, true);
    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

export async function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: false }));
  app.use(morgan(isProd ? "combined" : "dev"));
  app.use(cors(corsOptions));
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: true, limit: "4mb" }));

  // Uploaded images (profile pics, product photos)
  app.use(
    "/uploads",
    cors(corsOptions),
    express.static(UPLOAD_DIR, { maxAge: isProd ? "1h" : 0, fallthrough: true })
  );

  // ---------- API Routes ----------
  app.get("/api/health", async (req, res) => {
    try {
      const { get } = await import("./db.js");
      await get("SELECT 1 as ok");
      res.json({ status: "healthy", database: "connected", service: "bloodora-backend", time: new Date().toISOString() });
    } catch (e) {
      res.status(500).json({ status: "unhealthy", error: e.message });
    }
  });
  app.use("/api/auth", authRoutes);
  app.use("/api/meta", metaRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/donors", userRoutes); // alias: /api/donors == /api/users
  app.use("/api/blood-requests", bloodRoutes);
  app.use("/api/shop", shopRoutes);
  app.use("/api/messages", messageRoutes);
  app.use("/api/admin", adminRoutes);

  app.get("/health", (req, res) => res.redirect("/api/health"));
  app.get("/", (req, res) =>
    res.json({
      service: "BloodOra Backend API",
      status: "running",
      health: "/api/health",
      docs: "See backend/README.md in the repository",
      time: new Date().toISOString(),
    })
  );

  // 404 + error handling (JSON always)
  app.use((req, res) => res.status(404).json({ success: false, message: "Endpoint not found." }));
  app.use((err, req, res, next) => {
    if (err && err.message && err.message.startsWith("CORS blocked origin")) {
      return res.status(403).json({ success: false, message: err.message });
    }
    if (err && err.name === "MulterError") {
      return res.status(400).json({ success: false, message: "❌ Upload error: " + err.message });
    }
    console.error("Unhandled API error:", err);
    res.status(500).json({ success: false, message: "❌ Server error." });
  });

  // Initialize database schema + seeds before serving
  await initDB();
  console.log("✅ BloodOra backend DB ready — Turso serverless or local file");
  return app;
}
