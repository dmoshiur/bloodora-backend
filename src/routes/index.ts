import { Router } from "express";
import healthRoutes from "./health.js";
import authRoutes from "./auth.js";
import metaRoutes from "./meta.js";
import usersRoutes, { donorRouter } from "./users.js";
import shopRoutes, { adminRouter as shopAdminRoutes } from "./shop.js";
import bloodRoutes, { adminRouter as bloodAdminRoutes } from "./blood.js";
import messageRoutes from "./messages.js";
import supportRoutes, { adminRouter as supportAdminRoutes } from "./support.js";
import reviewRoutes from "./reviews.js";
import aiRoutes, { adminRouter as aiAdminRoutes } from "./ai.js";
import uploadRoutes, { serveRouter as uploadServeRoutes } from "./uploads.js";
import adminRoutes from "./admin.js";

const api = Router();

// A predictable response at the API base makes misconfigured frontend URLs
// immediately visible instead of looking like a generic 404.
api.get("/", (_req, res) => {
  res.json({ name: "bloodora-backend", status: "ok", health: "/api/health" });
});

api.use("/health", healthRoutes);
api.use("/auth", authRoutes);
api.use("/meta", metaRoutes);
api.use("/users", usersRoutes);
api.use("/donors", donorRouter);
api.use("/shop", shopRoutes);
api.use("/blood-requests", bloodRoutes);
api.use("/messages", messageRoutes);
api.use("/support", supportRoutes);
api.use("/reviews", reviewRoutes);
api.use("/ai", aiRoutes);
api.use("/uploads", uploadRoutes);

// Support admin — original contract: /api/support/admin/* (frontend proxy
// calls /api/support/admin/sessions etc.).
api.use("/support/admin", supportAdminRoutes);

// Admin namespace: /api/admin/*
// Shop admin (products/orders) is mounted FIRST so /api/admin/products and
// /api/admin/orders match the original contract; everything else falls
// through to the general admin router.
api.use("/admin", shopAdminRoutes);
api.use("/admin", adminRoutes);
api.use("/admin/blood-requests", bloodAdminRoutes);
api.use("/admin/ai", aiAdminRoutes);

// /api/uploads/:file alias for stored files.
api.use("/uploads", uploadServeRoutes);

export default api;
