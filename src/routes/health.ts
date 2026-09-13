import { Router } from "express";
import { ah } from "../utils/async.js";
import { health } from "../controllers/health.controller.js";

const router = Router();

router.get("/", ah(health));

export default router;
