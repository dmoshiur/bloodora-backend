import type { Request, Response } from "express";
import { Router } from "express";
import { ah } from "../utils/async.js";
import { str } from "../utils/validate.js";
import { optionalAuth } from "../middleware/auth.js";
import { metaService } from "../services/meta.service.js";
import { openSse, pollSse } from "../utils/sse.js";

const router = Router();

// Consolidated meta (original + this backend's richer view).
router.get("/", ah(async (_req: Request, res: Response) => {
  res.json(await metaService.get());
}));

// GET /api/meta/chat-auth — identity for the live chat widget. Logged-in
// visitors get their account identity; guests get a stable per-IP guest id so
// the widget can keep a thread across reloads.
router.get("/chat-auth", optionalAuth, ah(async (req: Request, res: Response) => {
  const u = req.user;
  if (u) {
    res.json({ uid: String(u.id), name: u.name, image: u.image_file || "default.jpg", is_admin: Boolean(u.is_admin) });
    return;
  }
  const ip = String(req.ip || "").replace(/\./g, "");
  res.json({ uid: `guest_${ip}`, name: "Guest User", image: "default.jpg", is_admin: false });
}));


// GET /api/meta/settings
router.get("/settings", ah(async (_req: Request, res: Response) => {
  res.json(await metaService.settingsView());
}));

// GET /api/meta/home
router.get("/home", ah(async (_req: Request, res: Response) => {
  res.json(await metaService.home());
}));

// GET /api/meta/activity?limit=
router.get("/activity", ah(async (req: Request, res: Response) => {
  res.json(await metaService.activity(Number(str(req.query.limit)) || 30));
}));

// GET /api/meta/activity/stream — SSE. Serverless-safe DB polling; the
// frontend falls back to 12s polling if the stream drops (short function
// time limits on the platform).
router.get("/activity/stream", (req: Request, res: Response) => {
  // Headers, close handling, the lifetime cap and interval teardown are shared
  // with the chat streams — see src/utils/sse.ts.
  const stream = openSse(req, res, { retryMs: 8000, label: "meta:activity" });
  let cursor = new Date(Date.now() - 60_000).toISOString();

  const tick = async () => {
    const events = await metaService.activitySince(cursor);
    for (const e of events) stream.write(e, "activity");
    cursor = new Date().toISOString();
  };

  pollSse(stream, 5000, tick);
});

// GET /api/meta/reviews?kind=&product_id=&rating=
router.get("/reviews", ah(async (req: Request, res: Response) => {
  res.json(await metaService.reviews({
    kind: str(req.query.kind) || undefined,
    productId: str(req.query.product_id) || undefined,
    rating: Number(str(req.query.rating)) || undefined,
  }));
}));

// GET /api/meta/antid
router.get("/antid", ah(async (_req: Request, res: Response) => {
  res.json(await metaService.antid());
}));

// GET /api/meta/compatibility
router.get("/compatibility", ah(async (_req: Request, res: Response) => {
  res.json(await metaService.compatibility());
}));

// GET /api/meta/resources?category=&q=
router.get("/resources", ah(async (req: Request, res: Response) => {
  res.json(await metaService.resources({
    category: str(req.query.category) || undefined,
    q: str(req.query.q) || undefined,
  }));
}));

// GET /api/meta/routes
router.get("/routes", ah(async (_req: Request, res: Response) => {
  res.json(await metaService.routes());
}));

// GET /api/meta/locations
router.get("/locations", ah(async (_req: Request, res: Response) => {
  res.json(await metaService.locations());
}));

export default router;
