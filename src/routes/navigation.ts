import { Router } from "express";
import { ah } from "../utils/async.js";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/rbac.js";
import * as c from "../controllers/navigation.controller.js";

/**
 * Mounted at /api/meta — public menu.
 *
 * `optionalAuth` (not `requireAuth`): an anonymous visitor must still get the
 * public area, but a signed-in caller gets the user/admin areas too, which is
 * the whole point of resolving the request here instead of in the client.
 */
export const publicRouter = Router();
publicRouter.get("/nav", optionalAuth, ah(c.nav));

/** Mounted at /api/admin — navigation administration. */
export const adminRouter = Router();
adminRouter.use(requireAuth);

adminRouter.get("/navigation", requirePermission("navigation.view"), ah(c.adminList));
// `/navigation/seed` and `/navigation/reorder` are declared before `/navigation/:id`
// so the literal segments are not captured as an id.
adminRouter.post("/navigation/seed", requirePermission("navigation.manage"), ah(c.adminSeed));
adminRouter.post("/navigation/reorder", requirePermission("navigation.manage"), ah(c.adminReorder));
adminRouter.post("/navigation", requirePermission("navigation.manage"), ah(c.adminCreate));
adminRouter.put("/navigation/:id", requirePermission("navigation.manage"), ah(c.adminUpdate));
adminRouter.patch("/navigation/:id", requirePermission("navigation.manage"), ah(c.adminUpdate));
adminRouter.post("/navigation/:id/toggle", requirePermission("navigation.manage"), ah(c.adminToggle));
adminRouter.delete("/navigation/:id", requirePermission("navigation.manage"), ah(c.adminRemove));
