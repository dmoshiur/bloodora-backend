import type { Request, Response } from "express";
import { Router } from "express";
import { ah } from "../utils/async.js";
import { str } from "../utils/validate.js";
import { metaService } from "../services/meta.service.js";

const router = Router();

// Consolidated meta (original + this backend's richer view).
router.get("/", ah(async (_req: Request, res: Response) => {
  res.json(await metaService.get());
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
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write("retry: 8000\n\n");

  let cursor = new Date(Date.now() - 60_000).toISOString();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const finish = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    try { res.end(); } catch { /* closed */ }
  };

  const tick = async () => {
    if (closed) return;
    try {
      const events = await metaService.activitySince(cursor);
      for (const e of events) {
        try { res.write(`event: activity\ndata: ${JSON.stringify(e)}\n\n`); } catch { finish(); return; }
      }
      cursor = new Date().toISOString();
    } catch {
      /* transient */
    }
  };

  void tick();
  timer = setInterval(() => void tick(), 5000);
  req.on("close", finish);
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
