import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { applySchema, SETTINGS_DEFAULTS } from "./schema.js";
import { seedProducts, seedDefaultImages } from "./seed.js";
import { antidReference, resourcesReference, siteRoutes } from "../data/content.js";
import { PERMISSIONS, ROLES } from "../data/permissions.js";
import { SEED_PRODUCTS } from "../data/products.js";
import { DEFAULT_IMAGES } from "../data/defaultImages.js";
import { batch } from "./query.js";
import { settingsRepo } from "../repos/settings.repo.js";
import { config } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { userRepo } from "../repos/user.repo.js";
import { rbacService } from "../services/rbac.service.js";
import { navigationService } from "../services/navigation.service.js";
import { randomId } from "../utils/errors.js";
import { withDeadline } from "./timeout.js";

/**
 * Database bootstrap.
 *
 * ============================ WHY THIS IS SHAPED LIKE THIS ====================
 * This function is the single thing that ran between "Vercel invoked the
 * function" and "the first `/api/*` response was written", and it was the reason
 * the deployment looked permanently stuck loading. Two independent defects:
 *
 * 1. **Round-trip count.** It issued 451 sequential `execute()` calls
 *    (80 DDL + 56 PRAGMA + 45 settings + 116 RBAC + 70 navigation + 58 seed
 *    reads/writes + content inserts). Against a *remote* Turso database every one
 *    of those is a separate HTTPS request. Measured: 5.3 s at a 20 ms RTT,
 *    18.3 s at 50 ms, 39.1 s at 80 ms, 70.3 s at 120 ms. Vercel's function
 *    maxDuration is 10 s on Hobby — so the invocation was killed mid-bootstrap,
 *    the in-memory memo was thrown away with the instance, and the next request
 *    started the whole 451-statement walk again from zero. It never converged.
 *    Every statement is now grouped into `batch()` calls (one HTTP request each)
 *    and a fingerprint marker lets a warm database skip seeding entirely:
 *      cold + empty DB  ≈ 21 round trips
 *      cold + warm DB   ≈  6 round trips
 *
 * 2. **No deadline.** `@libsql/client` has no internal timeout, so if Turso was
 *    merely unreachable the bootstrap promise never settled and the request hung
 *    forever rather than failing. `ensureDbReady()` now bounds the *wait* with
 *    `withDeadline()` while deliberately leaving the shared bootstrap running, so
 *    a slow first request answers 503 quickly instead of hanging and the second
 *    request finds the work already done.
 * ==========================================================================
 */

/** Settings key holding the fingerprint of the seed catalogue already applied. */
const BOOTSTRAP_MARKER = "bootstrap.catalogue_fingerprint";

let bootstrapping: Promise<void> | null = null;

/**
 * Stable hash of everything the seeders write.
 *
 * The marker only skips work when the *code's* catalogue is unchanged, so adding
 * a permission, a product, a route or a settings default automatically
 * invalidates it and the next boot reconciles — no manual version bump to forget.
 * DDL/migrations are deliberately excluded: `applySchema()` is cheap (≤5 batched
 * round trips) and always runs, so a schema change must not force a full reseed.
 */
function catalogueFingerprint(): string {
  const payload = JSON.stringify({
    v: 1,
    settings: Object.entries(SETTINGS_DEFAULTS).sort(),
    permissions: PERMISSIONS.map((p) => [p.key, p.name, p.group]),
    roles: ROLES.map((r) => [r.key, r.level, [...r.permissions].sort()]),
    routes: siteRoutes.map((r) => (r as { path: string }).path),
    products: SEED_PRODUCTS.map((p) => [p.id, p.slug, p.price, p.stock]),
    images: Object.keys(DEFAULT_IMAGES).sort(),
    antid: antidReference.indications.map((i) => i.condition),
    resources: resourcesReference.map((r) => r.title),
    superAdmin: config.superAdminEmail || null,
  });
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

/**
 * Request-path bootstrap: bounded.
 *
 * Rejects with a 503-shaped `DB_NOT_READY` after `DB_BOOTSTRAP_TIMEOUT_MS`
 * instead of waiting forever — but the underlying bootstrap keeps running and is
 * shared, so the *next* request usually finds it complete. That is the whole
 * point of `withDeadline` vs. resetting the memo: resetting would start a second
 * concurrent bootstrap against the same database and make the slow case slower.
 */
export function ensureDbReady(): Promise<void> {
  return withDeadline(startBootstrap(), config.dbBootstrapTimeoutMs, "database bootstrap");
}

/**
 * Unbounded bootstrap for CLIs and local dev (`npm run db:init`, `src/dev.ts`),
 * where there is no platform timeout to respect and a partial seed is worse than
 * a slow one. Shares the same memoized promise as `ensureDbReady()`.
 */
export function bootstrapDatabase(): Promise<void> {
  return startBootstrap();
}

/**
 * Circuit breaker around the bootstrap.
 *
 * Without it, every request arriving during a database outage restarted the
 * bootstrap and waited out the full deadline before answering — observed as five
 * consecutive `[BOOT] database: applying schema` lines, each costing the caller
 * 5 s. That is bounded, so it is not the original hang, but it is a bad outage
 * behaviour: it burns the platform's concurrent-instance budget serving waits
 * instead of fast 503s.
 *
 * After a failure we refuse to *start* another attempt for `BOOT_RETRY_BACKOFF_MS`
 * and reject immediately. An in-flight attempt is never cancelled or duplicated.
 */
const BOOT_RETRY_BACKOFF_MS = 5_000;
let lastFailureAt = 0;

function startBootstrap(): Promise<void> {
  if (!bootstrapping) {
    const sinceFailure = Date.now() - lastFailureAt;
    if (lastFailureAt > 0 && sinceFailure < BOOT_RETRY_BACKOFF_MS) {
      return Promise.reject(
        Object.assign(new Error("Database is not ready"), {
          status: 503,
          code: "DB_NOT_READY",
          retryAfterMs: BOOT_RETRY_BACKOFF_MS - sinceFailure,
        }),
      );
    }
    bootstrapping = bootstrap().catch((err) => {
      bootstrapping = null; // allow a later retry after the backoff
      lastFailureAt = Date.now();
      throw err;
    });
  }
  return bootstrapping;
}

async function bootstrap(): Promise<void> {
  const started = Date.now();
  logger.info("[BOOT] database: applying schema");
  // Stage 1 — always runs, always cheap: ≤5 batched round trips, all idempotent.
  await applySchema();
  const schemaMs = Date.now() - started;

  // Stage 2 — one query. A database this build has already seeded stops here.
  const fingerprint = catalogueFingerprint();
  const marker = await settingsRepo.get(BOOTSTRAP_MARKER).catch(() => null);
  if (marker === fingerprint) {
    logger.info("[BOOT] database: ready (catalogue unchanged — seeding skipped)", {
      schemaMs,
      totalMs: Date.now() - started,
      fingerprint,
    });
    return;
  }

  logger.info("[BOOT] database: seeding catalogue", {
    schemaMs,
    reason: marker ? "catalogue changed" : "first run",
  });

  const seeded = await seedProducts();
  const imagesSeeded = await seedDefaultImages();
  const contentSeeded = await seedContent();

  // Roles/permissions and the navigation catalogue are configuration the panel
  // edits at runtime, so they are seeded from code exactly once and then
  // reconciled when the catalogue changes. A failure here must not stop the app:
  // guards fall back to is_admin and the meta endpoint falls back to the built-in
  // catalogue — so it also must not block the marker from being written.
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

  await seedSuperAdmin();

  // Stage 3 — record what was applied so the next cold start skips straight past
  // this. Written LAST: if any stage above threw we get here only on the paths
  // that are safe to consider done, and a hard failure leaves the marker stale so
  // the next boot retries.
  await settingsRepo.set(BOOTSTRAP_MARKER, fingerprint);

  lastFailureAt = 0; // the breaker is closed again
  logger.info("[BOOT] database: ready", {
    schemaMs,
    totalMs: Date.now() - started,
    productsSeeded: seeded,
    imagesSeeded,
    contentSeeded,
    rolesSeeded,
    navigationSeeded: navSeeded,
    fingerprint,
  });
}

/**
 * Seed the content manager from the built-in clinical/educational reference
 * (once, on an empty database). Two round trips: one batched existence check, one
 * batched insert.
 */
async function seedContent(): Promise<string> {
  const counts = await batch([
    `SELECT COUNT(*) AS n FROM anti_d_info`,
    `SELECT COUNT(*) AS n FROM resources`,
  ]);
  const antidCount = Number((counts[0]?.rows?.[0] as unknown as { n: number } | undefined)?.n ?? 0);
  const resCount = Number((counts[1]?.rows?.[0] as unknown as { n: number } | undefined)?.n ?? 0);

  const writes: Array<[string, unknown[]]> = [];
  if (antidCount === 0) {
    for (const ind of antidReference.indications) {
      writes.push([
        `INSERT INTO anti_d_info (id, title, description, timing, dosage, image_file) VALUES (?, ?, ?, ?, ?, ?)`,
        [randomId(), ind.condition, `${ind.who}. ${ind.note}`, ind.when, "See the dosing schedule", null],
      ]);
    }
  }
  if (resCount === 0) {
    for (const [i, r] of resourcesReference.entries()) {
      writes.push([
        `INSERT INTO resources (id, title, category, content, summary, read_time, image_file, is_featured, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomId(), r.title, r.category, r.content, r.summary, r.readTime, null, i < 4 ? 1 : 0, "core"],
      ]);
    }
  }
  if (writes.length === 0) return "up-to-date";

  await batch(writes);

  const parts: string[] = [];
  if (antidCount === 0) parts.push(`${antidReference.indications.length} anti-D entries`);
  if (resCount === 0) parts.push(`${resourcesReference.length} resources`);
  return `seeded ${parts.join(" + ")}`;
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
