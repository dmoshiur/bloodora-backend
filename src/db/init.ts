import bcrypt from "bcryptjs";
import { applySchema } from "./schema.js";
import { seedProducts, seedDefaultImages } from "./seed.js";
import { antidReference, resourcesReference } from "../data/content.js";
import { contentRepo } from "../repos/content.repo.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { userRepo } from "../repos/user.repo.js";
import { rbacService } from "../services/rbac.service.js";
import { navigationService } from "../services/navigation.service.js";
import { randomId } from "../utils/errors.js";

let initializing: Promise<void> | null = null;

/**
 * Memoized, idempotent database bootstrap: DDL + settings defaults + product
 * seeds + super-admin provisioning. Multiple concurrent callers share one run.
 */
export function ensureDbReady(): Promise<void> {
  if (!initializing) {
    initializing = bootstrap().catch((err) => {
      initializing = null; // allow a later retry after a transient failure
      throw err;
    });
  }
  return initializing;
}

async function bootstrap(): Promise<void> {
  const started = Date.now();
  await applySchema();

  const seeded = await seedProducts();
  const imagesSeeded = await seedDefaultImages();
  const contentSeeded = await seedContent();

  // Roles/permissions and the navigation catalogue are configuration the panel
  // edits at runtime, so they are seeded from code exactly once and then
  // reconciled on every boot (new keys are granted, revocations are preserved).
  // A failure here must not stop the app: guards fall back to is_admin and the
  // meta endpoint falls back to the built-in catalogue.
  let rolesSeeded = "skipped";
  let navSeeded = 0;
  try {
    await rbacService.seed();
    rolesSeeded = "ok";
  } catch (err) {
    logger.error("db: RBAC seed failed (continuing with is_admin guards)", { err: String((err as Error)?.message ?? err) });
  }
  try {
    navSeeded = await navigationService.ensureSeeded();
  } catch (err) {
    logger.error("db: navigation seed failed (continuing with the built-in catalogue)", {
      err: String((err as Error)?.message ?? err),
    });
  }

  logger.info("db: schema ready", {
    ms: Date.now() - started,
    productsSeeded: seeded,
    imagesSeeded,
    contentSeeded,
    rolesSeeded,
    navigationSeeded: navSeeded,
  });

  await seedSuperAdmin();
}

/**
 * Seed the content manager from the built-in clinical/educational reference
 * (once, on an empty database — mirrors the original db.js bootstrap).
 */
async function seedContent(): Promise<string> {
  let note = "up-to-date";
  const antidCount = await contentRepo.countAntiD();
  if (antidCount === 0) {
    for (const ind of antidReference.indications) {
      await contentRepo.insertAntiD({
        id: randomId(),
        title: ind.condition,
        description: `${ind.who}. ${ind.note}`,
        timing: ind.when,
        dosage: "See the dosing schedule",
        image_file: null,
      });
    }
    note = `seeded ${antidReference.indications.length} anti-D entries`;
  }
  const resCount = await contentRepo.countResources();
  if (resCount === 0) {
    for (const [i, r] of resourcesReference.entries()) {
      await contentRepo.insertResource({
        id: randomId(),
        title: r.title,
        category: r.category,
        content: r.content,
        summary: r.summary,
        read_time: r.readTime,
        image_file: null,
        is_featured: i < 4 ? 1 : 0,
        source: "core",
      });
    }
    note = note === "up-to-date"
      ? `seeded ${resourcesReference.length} resources`
      : `${note} + ${resourcesReference.length} resources`;
  }
  return note;
}

/**
 * Provision the configured super admin exactly once (idempotent by email).
 * In production this is driven by the SUPER_ADMIN_* env vars; in dev it can be
 * left unset (the first registered user becomes the super admin instead).
 */
export async function seedSuperAdmin(): Promise<void> {
  const email = config.superAdminEmail;
  if (!email || !config.superAdminPassword) {
    logger.debug("db: no SUPER_ADMIN_* configured; first registered user becomes super admin");
    return;
  }
  try {
    await userRepo.create({
      id: randomId(),
      name: config.superAdminName,
      email: email.toLowerCase(),
      phone: config.superAdminPhone || "+8801000000000",
      password_hash: await bcrypt.hash(config.superAdminPassword, 10),
      is_admin: 1,
      is_super_admin: 1,
      role: "super_admin",
      donation_role: "Both",
      blood_group: null,
      city: null,
      address_holding: null,
      division: null,
      district: null,
      upazila: null,
      union_area: null,
      can_donate: 0,
      last_donation: null,
      age: null,
      date_of_birth: null,
      birth_certificate_number: null,
      bkash_number: null,
      nagad_number: null,
      upay_number: null,
      rocket_number: null,
      pathao_number: null,
      card_last_four: null,
      card_type: null,
      is_verified: 1,
      image_file: null,
      session_token: null,
    });
    logger.info("db: super admin ready", { email });
  } catch (err) {
    const e = err as { code?: number; message?: string };
    if (e.code === 1901 || /UNIQUE/i.test(e.message || "")) {
      logger.debug("db: super admin already exists");
      return;
    }
    throw err;
  }
}
