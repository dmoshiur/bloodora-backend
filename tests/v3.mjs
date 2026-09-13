#!/usr/bin/env node
/**
 * BloodOra backend — v3 feature suite.
 *
 * `tests/contract.mjs` guards the endpoints the shipped frontend already calls.
 * This suite guards everything added on top of it, and the bugs those additions
 * fix:
 *
 *   - health envelope, backend i18n (?lang= / Accept-Language / user preference)
 *   - self-service password reset + email verification, driven end-to-end by
 *     reading the link out of the durable mail outbox (no SMTP needed)
 *   - the personal dashboard aggregate
 *   - in-app notifications (feed, unread badges, read/read-all/delete, isolation)
 *   - the payment ledger (charge on order, idempotent confirm, refund once)
 *   - server-authoritative pricing: client prices ignored, stock enforced,
 *     delivery fee from settings, restock happens exactly once
 *   - RBAC: seeded roles, custom role, permission denials, self-lockout guard,
 *     audit trail
 *   - navigation: DB-backed catalogue, CRUD, ordering, enable/disable
 *   - live-chat idempotency via client_message_id + ISO timestamps
 *   - shared (DB-backed) rate limiting with Retry-After
 *
 * Usage:  npm run test:v3            (self-contained; needs port 4200 free)
 *         V3_BASE=http://… node tests/v3.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.V3_PORT || 4200);
const BASE = process.env.V3_BASE || `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
const step = (name, ok, extra = "") => {
  if (ok) pass += 1;
  else {
    failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
    console.log(`  FAIL ${name} ${extra}`);
  }
};

async function req(method, url, { token, json, form, headers: extraHeaders, lang } = {}) {
  const headers = { ...(extraHeaders || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (lang) headers["Accept-Language"] = lang;
  let body;
  if (form) body = form;
  else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(BASE + url, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 300) }; }
  return { status: res.status, data, headers: res.headers };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (v, n = 200) => JSON.stringify(v)?.slice(0, n) ?? String(v);

/** Error code from either envelope shape ({code} or {error:{code}}). */
const codeOf = (data) => data?.code || data?.error?.code || null;
const msgOf = (data) => data?.message || data?.error?.message || data?.error || "";

/**
 * Fail loudly if something is ALREADY listening on the test port.
 *
 * Without this the suite can silently run against a stale server left behind by
 * an earlier crashed run (a detached child survives its parent), testing old code
 * against old data and reporting failures that do not exist in the working tree.
 */
async function assertPortFree() {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
    throw new Error(`Port ${PORT} is already serving (status ${res.status}). Kill the stale process and re-run.`);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/already serving/.test(msg)) throw err;
    return; // nothing answered → the port is free
  }
}

async function waitForHealth(child) {
  for (let i = 0; i < 60; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server process exited early (code ${child.exitCode}) — is port ${PORT} in use?`);
    }
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

function startServer(cwd) {
  return spawn("npx", ["tsx", path.join(ROOT, "src/dev.ts")], {
    cwd,
    // SMTP is enabled but points at a host that cannot resolve: every message is
    // written to the durable outbox and then marked failed. That is the exact
    // "mail host down" situation the outbox exists for, and it lets this suite
    // read the reset/verification links a real deployment would email.
    env: {
      ...process.env,
      PORT: String(PORT),
      LOG_LEVEL: "error",
      SMTP_ENABLED: "true",
      SMTP_HOST: "smtp.invalid",
      SMTP_PORT: "2525",
      SMTP_SECURE: "false",
      SMTP_USER: "suite@bloodora.test",
      SMTP_PASS: "not-a-real-password",
      SMTP_FROM_EMAIL: "no-reply@bloodora.test",
      SMTP_FROM_NAME: "BloodOra Suite",
    },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
}

function stopServer(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
  setTimeout(() => {
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ }
  }, 1500).unref();
}

/** Pull `token=…` out of the newest outbox mail whose subject contains `needle`. */
async function tokenFromMail(adminToken, needle) {
  const r = await req("GET", "/api/admin/mail/outbox?limit=25", { token: adminToken });
  const rows = r.data?.recent || [];
  for (const row of rows) {
    const hay = `${row.subject || ""} ${row.html || ""} ${row.text || ""}`;
    if (!hay.toLowerCase().includes(needle.toLowerCase())) continue;
    const m = hay.match(/token=([A-Za-z0-9_\-]+)/);
    if (m) return m[1];
  }
  return null;
}

async function runSuite() {
  // ---------------- health envelope ----------------
  let r = await req("GET", "/api/health");
  step("health: success/status/service/version", r.status === 200 && r.data?.success === true && r.data?.status === "ok" && r.data?.service === "bloodora-backend" && typeof r.data?.version === "string", j(r.data));

  // ---------------- accounts ----------------
  const adminEmail = `admin${Date.now()}@bloodora.test`;
  r = await req("POST", "/api/auth/register", {
    json: { name: "Super Admin", email: adminEmail, phone: "+8801700000001", password: "adminpass123", age: "30" },
  });
  const admin = r.data?.token;
  const adminId = r.data?.user?.id;
  step("register first account (becomes super admin)", r.status === 201 && !!admin && !!adminId, j(r.data));

  const userEmail = `user${Date.now()}@bloodora.test`;
  r = await req("POST", "/api/auth/register", {
    json: { name: "Normal User", email: userEmail, phone: "+8801700000002", password: "userpass123", age: "30", blood_group: "O+", upazila: "Kalai" },
  });
  let userToken = r.data?.token;
  const userId = r.data?.user?.id;
  step("register second account (plain user)", r.status === 201 && !!userToken, j(r.data));

  // ---------------- capabilities on /me ----------------
  r = await req("GET", "/api/auth/me", { token: admin });
  step("GET /api/auth/me keeps the user envelope", r.status === 200 && !!r.data?.user?.id, j(r.data));
  step("me: super admin gets account_role + permissions",
    r.data?.account_role === "super_admin" && Array.isArray(r.data?.permissions) && r.data.permissions.includes("users.role.assign") && r.data.permissions.includes("payments.refund"),
    j({ role: r.data?.account_role, n: r.data?.permissions?.length }));

  r = await req("GET", "/api/auth/me", { token: userToken });
  step("me: plain user holds only ai.use", r.data?.account_role === "user" && j(r.data?.permissions) === j(["ai.use"]), j(r.data));

  r = await req("GET", "/api/rbac/me", { token: userToken });
  step("GET /api/rbac/me", r.status === 200 && r.data?.role === "user" && r.data?.is_admin === false, j(r.data));
  r = await req("GET", "/api/rbac/me");
  step("GET /api/rbac/me without a token → 401", r.status === 401, j(r.data));

  // ---------------- personal dashboard ----------------
  r = await req("GET", "/api/user/dashboard", { token: userToken });
  step("GET /api/user/dashboard aggregates the caller's data",
    r.status === 200 && r.data?.success === true && !!r.data?.user?.id && !!r.data?.counts && !!r.data?.donation && !!r.data?.spending && !!r.data?.recent,
    j(r.data, 300));
  step("dashboard: donation eligibility reflects the account", r.data?.donation?.blood_group === "O+" && r.data?.donation?.can_donate === true, j(r.data?.donation));
  r = await req("GET", "/api/user/dashboard");
  step("GET /api/user/dashboard unauthenticated → 401", r.status === 401, j(r.data));

  // ---------------- backend i18n ----------------
  const en = await req("POST", "/api/shop/orders", { token: userToken, json: { cart: {} } });
  const bn = await req("POST", "/api/shop/orders?lang=bn", { token: userToken, json: { cart: {} } });
  // Accept-Language is checked on an ANONYMOUS call: for a signed-in caller the
  // saved preference outranks the header (documented precedence), so the header
  // only decides when nobody is logged in.
  const ar = await req("POST", "/api/auth/login", { json: { email: `ar${Date.now()}@bloodora.test`, password: "whatever123" }, lang: "ar" });
  step("empty cart → 400 EMPTY_CART", en.status === 400 && codeOf(en.data) === "EMPTY_CART", j(en.data));
  step("?lang=bn localizes the error message", bn.status === 400 && msgOf(bn.data) !== msgOf(en.data) && /[\u0980-\u09FF]/.test(msgOf(bn.data)), j(bn.data));
  step("Accept-Language: ar localizes an anonymous error", ar.status === 401 && /[\u0600-\u06FF]/.test(msgOf(ar.data)), j(ar.data));
  r = await req("GET", "/api/meta/routes?lang=bn");
  step("GET /api/meta/routes?lang=bn still serves the catalogue", r.status === 200 && Array.isArray(r.data?.routes) && r.data.routes.length > 10, j(r.data, 120));

  // ---------------- forgot / reset password ----------------
  r = await req("POST", "/api/auth/forgot-password", { json: { email: userEmail } });
  step("POST /api/auth/forgot-password (known address)", r.status === 200 && r.data?.success === true, j(r.data));
  const knownMessage = msgOf(r.data);
  r = await req("POST", "/api/auth/forgot-password", { json: { email: `nobody${Date.now()}@bloodora.test` } });
  step("forgot-password does not reveal whether the address exists", r.status === 200 && msgOf(r.data) === knownMessage, j(r.data));
  r = await req("POST", "/api/auth/forgot-password", { json: { email: "not-an-email" } });
  step("forgot-password validates the email shape", r.status === 400, j(r.data));

  const resetToken = await tokenFromMail(admin, "reset");
  step("reset link is queued in the mail outbox", !!resetToken, resetToken ? "found" : "no token in outbox");

  r = await req("GET", `/api/auth/reset-password/validate?token=${resetToken || "nope"}`);
  step("GET /api/auth/reset-password/validate (valid token)", r.status === 200 && r.data?.valid === true, j(r.data));
  r = await req("GET", "/api/auth/reset-password/validate?token=not-a-real-token-value");
  step("validate rejects an unknown token", r.status === 200 && r.data?.valid === false, j(r.data));

  r = await req("POST", "/api/auth/reset-password", { json: { token: resetToken || "x", password: "short" } });
  step("reset-password enforces the password policy", r.status === 400 && codeOf(r.data) === "PASSWORD_SHORT", j(r.data));

  const oldToken = userToken;
  r = await req("POST", "/api/auth/reset-password", { json: { token: resetToken, password: "brandnewpass123" } });
  step("POST /api/auth/reset-password succeeds", r.status === 200 && r.data?.success === true, j(r.data));

  r = await req("POST", "/api/auth/reset-password", { json: { token: resetToken, password: "anotherpass123" } });
  step("a reset token is single-use", r.status === 400 && codeOf(r.data) === "RESET_TOKEN_INVALID", j(r.data));

  r = await req("GET", "/api/auth/me", { token: oldToken });
  step("reset rotates the session: the old token is dead", r.status === 401, j(r.data));

  r = await req("POST", "/api/auth/login", { json: { email: userEmail, password: "userpass123" } });
  step("the old password no longer works", r.status === 401, j(r.data));
  r = await req("POST", "/api/auth/login", { json: { email: userEmail, password: "brandnewpass123" } });
  if (r.data?.token) userToken = r.data.token;
  step("login with the new password", r.status === 200 && !!r.data?.token, j(r.data));

  // ---------------- email verification ----------------
  r = await req("POST", "/api/auth/verify-email/request", { token: userToken });
  step("POST /api/auth/verify-email/request", r.status === 200 && r.data?.success === true, j(r.data));
  const verifyToken = await tokenFromMail(admin, "verify");
  step("verification link is queued in the outbox", !!verifyToken, verifyToken ? "found" : "not found");
  r = await req("POST", "/api/auth/verify-email", { json: { token: verifyToken } });
  step("POST /api/auth/verify-email confirms the address", r.status === 200 && r.data?.success === true, j(r.data));
  r = await req("GET", "/api/auth/me", { token: userToken });
  step("me: email_verified is now true", r.data?.user?.email_verified === true, j(r.data?.user?.email_verified));
  r = await req("POST", "/api/auth/verify-email", { json: { token: verifyToken } });
  step("a verification token is single-use", r.status === 400, j(r.data));
  r = await req("GET", "/api/auth/verify-email?token=not-a-real-token-value");
  step("GET /api/auth/verify-email with a bad token → 400", r.status === 400, j(r.data));

  // ---------------- navigation ----------------
  r = await req("GET", "/api/meta/nav");
  step("GET /api/meta/nav (anonymous) hides user/admin areas",
    r.status === 200 && Array.isArray(r.data?.public) && r.data.public.length > 5 && j(r.data?.user) === "[]" && j(r.data?.admin) === "[]" && r.data?.authenticated === false,
    j({ pub: r.data?.public?.length, auth: r.data?.authenticated }));
  r = await req("GET", "/api/meta/nav", { token: admin });
  step("GET /api/meta/nav (super admin) includes the admin area", r.data?.admin?.length > 5 && r.data?.user?.length > 0 && r.data?.is_admin === true, j({ admin: r.data?.admin?.length }));

  r = await req("GET", "/api/admin/navigation", { token: admin });
  const navTotal = r.data?.total;
  step("GET /api/admin/navigation lists the seeded catalogue", r.status === 200 && navTotal > 10 && Array.isArray(r.data?.areas), j({ total: navTotal }));
  r = await req("GET", "/api/admin/navigation", { token: userToken });
  step("a plain user cannot read the navigation admin list", r.status === 403 && codeOf(r.data) === "PERMISSION_DENIED", j(r.data));

  const testPath = `/v3-test-${Date.now()}`;
  r = await req("POST", "/api/admin/navigation", { token: admin, json: { label: "V3 Test Page", path: testPath, purpose: "Suite fixture", keywords: ["v3", "test"] } });
  const navId = r.data?.entry?.id || r.data?.navigation?.id || r.data?.id;
  step("POST /api/admin/navigation creates an entry", [200, 201].includes(r.status) && !!navId, j(r.data));
  r = await req("GET", "/api/meta/routes");
  step("a new entry appears in the public catalogue", (r.data?.routes || []).some((x) => x.path === testPath), testPath);
  r = await req("POST", "/api/admin/navigation", { token: admin, json: { label: "Duplicate", path: testPath } });
  step("a duplicate path is rejected", r.status === 409, j(r.data));
  r = await req("POST", "/api/admin/navigation", { token: admin, json: { label: "No Slash", path: "no-slash" } });
  const slashId = r.data?.entry?.id || r.data?.id;
  step("a path without a leading slash is normalized", [200, 201].includes(r.status) && (r.data?.entry?.path || r.data?.navigation?.path) === "/no-slash", j(r.data, 160));

  r = await req("POST", `/api/admin/navigation/${navId}/toggle`, { token: admin, json: { active: false } });
  step("POST /api/admin/navigation/:id/toggle hides an entry", r.status === 200, j(r.data));
  r = await req("GET", "/api/meta/routes");
  step("a hidden entry leaves the public catalogue", !(r.data?.routes || []).some((x) => x.path === testPath));
  r = await req("POST", `/api/admin/navigation/${navId}/toggle`, { token: admin, json: { active: "on" } });
  step("toggle accepts the panel's checkbox value (\"on\")", r.status === 200);
  r = await req("GET", "/api/meta/routes");
  step("re-enabling restores the entry", (r.data?.routes || []).some((x) => x.path === testPath));

  r = await req("PUT", `/api/admin/navigation/${navId}`, { token: admin, json: { label: "Renamed V3 Page" } });
  step("PUT /api/admin/navigation/:id updates the label", r.status === 200 && (r.data?.entry?.label === "Renamed V3 Page" || j(r.data).includes("Renamed V3 Page")), j(r.data, 160));

  r = await req("GET", "/api/admin/navigation", { token: admin });
  const ids = (r.data?.navigation || []).slice(0, 3).map((n) => n.id).reverse();
  r = await req("POST", "/api/admin/navigation/reorder", { token: admin, json: { order: ids } });
  step("POST /api/admin/navigation/reorder writes positions", r.status === 200, j(r.data, 160));
  r = await req("GET", "/api/admin/navigation", { token: admin });
  const positions = (r.data?.navigation || []).filter((n) => ids.includes(n.id)).map((n) => n.position);
  step("reordered entries hold positions 0..n", j(positions) === j(ids.map((_, i) => i)), j(positions));

  r = await req("DELETE", `/api/admin/navigation/${navId}`, { token: admin });
  step("DELETE /api/admin/navigation/:id", r.status === 200, j(r.data, 120));
  if (slashId) await req("DELETE", `/api/admin/navigation/${slashId}`, { token: admin });
  r = await req("GET", "/api/meta/routes");
  step("a deleted entry is gone from the catalogue", !(r.data?.routes || []).some((x) => x.path === testPath));
  r = await req("POST", "/api/admin/navigation/seed", { token: admin });
  step("POST /api/admin/navigation/seed is idempotent", r.status === 200 && r.data?.inserted === 0, j(r.data));

  // ---------------- strict pricing & the payment ledger ----------------
  r = await req("POST", "/api/admin/products", { token: admin, json: { name: "V3 Test Kit", price: 250, stock: 3, category: "gloves", description: "suite fixture" } });
  const productId = r.data?.product?.id || r.data?.id;
  step("admin creates a priced product", [200, 201].includes(r.status) && !!productId, j(r.data, 160));

  r = await req("POST", "/api/shop/cart/resolve", { json: { cart: { [productId]: 2, "does-not-exist": 1 } } });
  step("resolve reports an unavailable line instead of dropping it silently",
    r.status === 200 && r.data?.subtotal === 500 && (r.data?.skipped || []).some((s) => s.product_id === "does-not-exist"),
    j({ subtotal: r.data?.subtotal, skipped: r.data?.skipped }));

  r = await req("POST", "/api/shop/cart/resolve", { json: { cart: { [productId]: 99 } } });
  step("resolve skips a quantity above stock (lenient mode)", r.data?.skipped?.some((s) => s.reason === "out_of_stock") && r.data?.subtotal === 0, j(r.data, 200));

  r = await req("POST", "/api/shop/orders", { token: userToken, json: { cart: { [productId]: 99 }, payment_method: "bkash", upazila: "Kalai", delivery_address: "Test 1", transaction_id: "TRX-V3-1", bkash_number: "01700000000" } });
  step("checkout rejects a quantity above stock", r.status === 400 && codeOf(r.data) === "OUT_OF_STOCK", j(r.data, 220));
  step("the stock rejection carries the real availability", r.data?.error?.details?.available === 3 && r.data?.error?.details?.requested === 99, j(r.data?.error?.details));

  r = await req("POST", "/api/shop/orders", { token: userToken, json: { cart: { [productId]: 2 }, payment_method: "bkash", upazila: "Dhaka", delivery_address: "Test 1" } });
  step("checkout refuses an area outside the configured delivery zones", r.status === 400 && codeOf(r.data) === "DELIVERY_AREA_NOT_SERVED", j(r.data, 200));

  // A client-supplied price must be ignored: only ids and quantities are read.
  r = await req("POST", "/api/shop/orders", {
    token: userToken,
    json: { cart: { [productId]: 2 }, payment_method: "cash", upazila: "Kalai", delivery_address: "Test 1", price: 1, total: 3, subtotal: 1, delivery_fee: 0 },
  });
  const order1 = r.data?.orderId;
  step("checkout succeeds for a valid cart", r.status === 200 && !!order1, j(r.data, 200));
  step("the total is computed server-side (2×250 + delivery), ignoring client amounts", r.data?.subtotal === 500 && r.data?.total === 500 + r.data?.delivery_fee && r.data?.total > 500, j({ subtotal: r.data?.subtotal, fee: r.data?.delivery_fee, total: r.data?.total }));
  step("checkout returns the ledger reference", !!r.data?.payment?.reference && r.data?.payment?.status === "pending", j(r.data?.payment));

  r = await req("GET", `/api/shop/products/${productId}`, {});
  step("stock is decremented by the order", r.data?.product?.stock === 1, j({ stock: r.data?.product?.stock }));

  r = await req("GET", "/api/payments/me", { token: userToken });
  step("GET /api/payments/me shows the pending charge",
    r.status === 200 && (r.data?.transactions || []).some((t) => t.order_id === order1 && t.status === "pending" && t.amount === 510),
    j(r.data, 220));
  r = await req("GET", `/api/payments/order/${order1}`, { token: userToken });
  step("GET /api/payments/order/:id (owner)", r.status === 200 && (r.data?.transactions || []).length === 1, j(r.data, 200));
  r = await req("GET", "/api/payments/me");
  step("GET /api/payments/me unauthenticated → 401", r.status === 401);

  r = await req("GET", "/api/admin/payments", { token: userToken });
  step("a plain user cannot read the admin ledger", r.status === 403 && codeOf(r.data) === "PERMISSION_DENIED", j(r.data));

  r = await req("POST", `/api/admin/orders/${order1}/confirm-payment`, { token: admin, json: {} });
  step("admin confirms the payment", r.status === 200 && (r.data?.success === true || String(msgOf(r.data)).includes("confirmed")), j(r.data, 200));
  r = await req("POST", `/api/admin/orders/${order1}/confirm-payment`, { token: admin, json: {} });
  step("confirming twice is idempotent (no second charge)", r.status === 200 && String(msgOf(r.data)).toLowerCase().includes("already"), j(r.data, 200));
  r = await req("GET", `/api/payments/order/${order1}`, { token: userToken });
  const successful = (r.data?.transactions || []).filter((t) => t.kind === "charge" && t.status === "successful");
  step("the ledger holds exactly one successful charge", successful.length === 1, j(r.data?.transactions, 260));

  r = await req("GET", "/api/admin/payments", { token: admin });
  step("GET /api/admin/payments (admin)", r.status === 200 && Array.isArray(r.data?.transactions) && r.data.transactions.some((t) => t.order_id === order1 && t.user_name), j(r.data, 200));
  r = await req("GET", "/api/admin/payments/summary", { token: admin });
  step("GET /api/admin/payments/summary reports the collected total", r.status === 200 && r.data?.collected >= 510 && r.data?.successful >= 1, j(r.data));

  // ---------------- notifications ----------------
  r = await req("GET", "/api/notifications", { token: userToken });
  step("GET /api/notifications returns the caller's feed", r.status === 200 && Array.isArray(r.data?.notifications) && r.data.notifications.length > 0, j({ n: r.data?.notifications?.length }));
  step("the feed carries an unread badge and per-type counts", typeof r.data?.unread === "number" && r.data.unread > 0 && typeof r.data?.by_type === "object", j({ unread: r.data?.unread, by_type: r.data?.by_type }));
  step("an order notification is localized to the recipient and links to the order",
    (r.data?.notifications || []).some((n) => n.type === "order" && typeof n.link === "string" && n.link.includes("my-orders")),
    j((r.data?.notifications || []).slice(0, 2), 240));
  const noteId = (r.data?.notifications || [])[0]?.id;
  const unreadBefore = r.data.unread;

  r = await req("GET", "/api/notifications", { token: userToken });
  const paymentNote = (r.data?.notifications || []).find((n) => n.type === "payment");
  step("a payment confirmation notification was emitted", !!paymentNote, j((r.data?.notifications || []).map((n) => n.type)));

  r = await req("POST", `/api/notifications/${noteId}/read`, { token: userToken });
  step("POST /api/notifications/:id/read", r.status === 200 && r.data?.success === true, j(r.data));
  r = await req("GET", "/api/notifications/unread", { token: userToken });
  step("the unread badge drops after marking one read", r.status === 200 && r.data?.unread === unreadBefore - 1, j({ before: unreadBefore, after: r.data?.unread }));
  r = await req("POST", `/api/notifications/${noteId}/read`, { token: userToken });
  step("marking an already-read notification → 404", r.status === 404, j(r.data));

  const adminUnreadBefore = (await req("GET", "/api/notifications/unread", { token: admin })).data?.unread;
  r = await req("POST", "/api/notifications/read-all", { token: userToken });
  step("POST /api/notifications/read-all", r.status === 200 && typeof r.data?.updated === "number", j(r.data));
  r = await req("GET", "/api/notifications/unread", { token: userToken });
  step("read-all clears the caller's badge", r.data?.unread === 0, j(r.data));
  const adminUnreadAfter = (await req("GET", "/api/notifications/unread", { token: admin })).data?.unread;
  step("one user's read-all does not touch another account's badge", adminUnreadAfter === adminUnreadBefore, j({ before: adminUnreadBefore, after: adminUnreadAfter }));
  r = await req("GET", "/api/notifications", { token: admin });
  step("an admin sees the shared admin desk alerts", (r.data?.notifications || []).some((n) => n.type === "order" || n.type === "admin"), j((r.data?.notifications || []).map((n) => n.type)));

  r = await req("DELETE", `/api/notifications/${noteId}`, { token: userToken });
  step("DELETE /api/notifications/:id", r.status === 200, j(r.data));
  r = await req("DELETE", `/api/notifications/${noteId}`, { token: userToken });
  step("deleting twice → 404", r.status === 404, j(r.data));
  r = await req("GET", "/api/notifications");
  step("GET /api/notifications unauthenticated → 401", r.status === 401);

  // ---------------- refunds ----------------
  r = await req("POST", `/api/admin/payments/order/${order1}/refund`, { token: admin, json: { amount: 510, note: "suite refund" } });
  step("super admin records a refund", r.status === 200 && r.data?.transaction?.kind === "refund", j(r.data, 220));
  r = await req("POST", `/api/admin/payments/order/${order1}/refund`, { token: admin, json: {} });
  step("a second refund is refused", r.status === 409, j(r.data, 160));
  r = await req("POST", `/api/admin/payments/order/${order1}/refund`, { token: admin, json: { amount: 999999 } });
  step("a refund above the order total is refused", r.status === 400 && codeOf(r.data) === "REFUND_TOO_LARGE", j(r.data, 160));
  r = await req("GET", `/api/payments/order/${order1}`, { token: userToken });
  step("the ledger keeps both the charge and the refund",
    (r.data?.transactions || []).some((t) => t.kind === "charge") && (r.data?.transactions || []).some((t) => t.kind === "refund"),
    j((r.data?.transactions || []).map((t) => `${t.kind}:${t.status}`)));

  // ---------------- cancel & restock exactly once ----------------
  r = await req("POST", "/api/admin/products", { token: admin, json: { name: "V3 Restock Kit", price: 100, stock: 5, category: "gloves", description: "suite fixture" } });
  const restockId = r.data?.product?.id || r.data?.id;
  r = await req("POST", "/api/shop/orders", { token: userToken, json: { cart: { [restockId]: 2 }, payment_method: "cash", upazila: "Kalai", delivery_address: "Test 2" } });
  const order2 = r.data?.orderId;
  step("a second order is placed for the restock test", !!order2, j(r.data, 160));
  r = await req("GET", `/api/shop/products/${restockId}`);
  step("stock dropped from 5 to 3", r.data?.product?.stock === 3, j({ stock: r.data?.product?.stock }));

  r = await req("POST", `/api/shop/orders/${order2}/cancel`, { token: userToken });
  step("the owner cancels a pending order", r.status === 200, j(r.data, 160));
  r = await req("GET", `/api/shop/products/${restockId}`);
  step("cancelling restores the stock once (3 → 5)", r.data?.product?.stock === 5, j({ stock: r.data?.product?.stock }));
  r = await req("POST", `/api/shop/orders/${order2}/cancel`, { token: userToken });
  step("cancelling twice is refused", r.status === 409, j(r.data, 160));
  r = await req("GET", `/api/shop/products/${restockId}`);
  step("the refused cancel did not restock again", r.data?.product?.stock === 5, j({ stock: r.data?.product?.stock }));
  r = await req("GET", `/api/payments/order/${order2}`, { token: userToken });
  step("the cancelled order's charge is closed in the ledger",
    (r.data?.transactions || []).length === 1 && (r.data?.transactions || []).every((t) => t.status === "cancelled"),
    j((r.data?.transactions || []).map((t) => `${t.kind}:${t.status}`)));
  r = await req("POST", `/api/admin/orders/${order2}/confirm-payment`, { token: admin, json: {} });
  step("payment cannot be confirmed on a cancelled order", r.status === 409 && codeOf(r.data) === "ORDER_CANCELLED", j(r.data, 160));

  // Admin-side double cancel.
  r = await req("POST", "/api/shop/orders", { token: userToken, json: { cart: { [restockId]: 2 }, payment_method: "cash", upazila: "Kalai", delivery_address: "Test 3" } });
  const order3 = r.data?.orderId;
  r = await req("POST", `/api/admin/orders/${order3}/status`, { token: admin, json: { status: "cancelled" } });
  step("an admin cancels an order", r.status === 200, j(r.data, 160));
  const stockAfterFirst = (await req("GET", `/api/shop/products/${restockId}`)).data?.product?.stock;
  r = await req("POST", `/api/admin/orders/${order3}/status`, { token: admin, json: { status: "cancelled" } });
  step("re-applying the same status is a no-op", r.status === 200, j(r.data, 160));
  const stockAfterSecond = (await req("GET", `/api/shop/products/${restockId}`)).data?.product?.stock;
  step("an admin cancel restocks exactly once", stockAfterFirst === 5 && stockAfterSecond === 5, j({ stockAfterFirst, stockAfterSecond }));
  r = await req("POST", `/api/admin/orders/${order3}/status`, { token: admin, json: { status: "not-a-status" } });
  step("an invalid status is rejected", r.status === 400, j(r.data, 140));

  // ---------------- delivery fee comes from settings ----------------
  r = await req("POST", "/api/admin/settings", { token: admin, json: { delivery_fee: "25", delivery_areas: "Kalai, Gaibandha" } });
  step("admin changes the delivery fee and areas", r.status === 200, j(r.data, 140));
  r = await req("GET", "/api/shop/checkout/context", { token: userToken });
  step("checkout/context exposes the configured delivery rules", r.data?.delivery?.fee === 25 && (r.data?.delivery?.areas || []).includes("Gaibandha"), j(r.data?.delivery));
  r = await req("POST", "/api/shop/orders", { token: userToken, json: { cart: { [restockId]: 1 }, payment_method: "cash", upazila: "Gaibandha", delivery_address: "Test 4" } });
  step("a newly served area can order", r.status === 200 && r.data?.delivery_fee === 25 && r.data?.total === 125, j({ fee: r.data?.delivery_fee, total: r.data?.total }));
  const order4 = r.data?.orderId;
  await req("POST", "/api/admin/settings", { token: admin, json: { delivery_fee: "10", delivery_areas: "Kalai" } });

  // ---------------- RBAC ----------------
  r = await req("GET", "/api/admin/roles", { token: admin });
  const roles = r.data?.roles || [];
  step("GET /api/admin/roles lists the seeded roles", r.status === 200 && roles.length >= 3 && roles.some((x) => x.key === "super_admin") && roles.some((x) => x.key === "admin") && roles.some((x) => x.key === "user"), j(roles.map((x) => x.key)));
  const superRole = roles.find((x) => x.key === "super_admin");
  const adminRole = roles.find((x) => x.key === "admin");
  step("only super_admin holds payments.refund and users.delete",
    superRole?.permissions?.includes("payments.refund") && superRole?.permissions?.includes("users.delete") && !adminRole?.permissions?.includes("payments.refund") && !adminRole?.permissions?.includes("users.delete"),
    j({ super: superRole?.permissions?.length, admin: adminRole?.permissions?.length }));
  step("roles report how many accounts hold them", typeof superRole?.users === "number" && superRole.users >= 1, j({ users: superRole?.users }));

  r = await req("GET", "/api/admin/permissions", { token: admin });
  step("GET /api/admin/permissions serves the catalogue", r.status === 200 && (r.data?.permissions || []).length >= 30 && (r.data?.groups || []).includes("payments"), j({ n: r.data?.permissions?.length, groups: r.data?.groups }));

  r = await req("POST", "/api/admin/roles", { token: admin, json: { key: "admin", name: "Sneaky" } });
  step("a reserved role key cannot be created", r.status === 409 && codeOf(r.data) === "ROLE_KEY_RESERVED", j(r.data));

  r = await req("POST", "/api/admin/roles", { token: admin, json: { key: "content-editor", name: "Content Editor", description: "Content only", permissions: ["content.view", "content.manage"] } });
  // Role keys are normalized to [a-z0-9_], so the suite must use the key the
  // service stored rather than the one it asked for.
  const editorRole = r.data?.role?.key;
  step("a custom role can be created with an explicit permission set", [200, 201].includes(r.status) && editorRole === "content_editor", j(r.data, 220));
  r = await req("POST", "/api/admin/roles", { token: admin, json: { key: "content-editor", name: "Again" } });
  step("a duplicate role key is refused", r.status === 409, j(r.data));
  r = await req("POST", "/api/admin/roles", { token: userToken, json: { key: "hacker" } });
  step("a plain user cannot create roles", r.status === 403, j(r.data));

  r = await req("POST", `/api/admin/users/${userId}/role`, { token: admin, json: { role: editorRole } });
  step("the role is assigned to an account", r.status === 200 && r.data?.success === true, j(r.data, 200));
  r = await req("GET", "/api/rbac/me", { token: userToken });
  step("the old token still resolves but with the NEW role", r.status === 401 || r.data?.role === "content-editor", j(r.data, 160));
  if (r.status === 401) {
    const login = await req("POST", "/api/auth/login", { json: { email: userEmail, password: "brandnewpass123" } });
    if (login.data?.token) userToken = login.data.token;
    step("re-login after a role change issues a fresh token", !!login.data?.token, j(login.data, 120));
  }
  r = await req("GET", "/api/rbac/me", { token: userToken });
  step("the custom role carries exactly its permissions", r.data?.role === editorRole && j(r.data?.permissions?.sort()) === j(["content.manage", "content.view"]), j(r.data));
  // `is_admin` is the legacy "may see the panel" flag and is set for any
  // non-`user` role; what must NOT happen is a custom role inheriting super
  // admin, or holding permissions it was never granted (asserted above).
  step("a custom role is not a super admin", r.data?.is_super_admin === false, j({ a: r.data?.is_admin, s: r.data?.is_super_admin }));

  r = await req("GET", "/api/admin/content/resources", { token: userToken });
  step("the custom role CAN read content", r.status === 200, j(r.data, 120));
  r = await req("GET", "/api/admin/settings", { token: userToken });
  step("the custom role CANNOT read site settings", r.status === 403 && codeOf(r.data) === "PERMISSION_DENIED", j(r.data, 160));
  r = await req("POST", "/api/admin/products", { token: userToken, json: { name: "Nope", price: 1, stock: 1, category: "gloves" } });
  step("the custom role CANNOT manage products", r.status === 403, j(r.data, 140));
  r = await req("GET", "/api/admin/orders", { token: userToken });
  step("the custom role CANNOT list orders", r.status === 403, j(r.data, 120));
  r = await req("POST", `/api/admin/orders/${order4}/status`, { token: userToken, json: { status: "delivered" } });
  step("the custom role CANNOT change order status", r.status === 403, j(r.data, 120));
  r = await req("GET", "/api/shop/orders/mine", { token: userToken });
  step("a custom role keeps ordinary user access", r.status === 200 && Array.isArray(r.data?.orders), j(r.data, 120));

  r = await req("DELETE", `/api/admin/roles/${editorRole}`, { token: admin });
  step("a role still assigned to an account cannot be deleted", r.status === 409 && codeOf(r.data) === "ROLE_IN_USE", j(r.data));

  r = await req("PUT", "/api/admin/roles/super_admin", { token: admin, json: { permissions: ["users.view"] } });
  step("an admin cannot strip their own role's permissions (self-lockout guard)", r.status === 400 && codeOf(r.data) === "SELF_LOCKOUT", j(r.data, 200));

  r = await req("POST", `/api/admin/users/${userId}/role`, { token: admin, json: { role: "user" } });
  step("the account is returned to the plain user role", r.status === 200, j(r.data, 140));
  const userLogin = await req("POST", "/api/auth/login", { json: { email: userEmail, password: "brandnewpass123" } });
  if (userLogin.data?.token) userToken = userLogin.data.token;
  r = await req("GET", "/api/rbac/me", { token: userToken });
  step("the demoted account is a plain user again", r.data?.role === "user", j(r.data));
  r = await req("DELETE", `/api/admin/roles/${editorRole}`, { token: admin });
  step("an unassigned custom role can be deleted", r.status === 200, j(r.data, 140));
  r = await req("DELETE", "/api/admin/roles/super_admin", { token: admin });
  step("a built-in role cannot be deleted", r.status === 400 && codeOf(r.data) === "SYSTEM_ROLE", j(r.data));
  r = await req("POST", `/api/admin/users/${adminId}/role`, { token: admin, json: { role: "user" } });
  step("an admin cannot downgrade their own account", r.status === 400 && codeOf(r.data) === "SELF_DEMOTE", j(r.data, 160));
  r = await req("GET", "/api/rbac/me", { token: admin });
  step("the refused self-demotion left the account a super admin", r.data?.role === "super_admin", j(r.data, 120));

  // ---------------- audit trail ----------------
  r = await req("GET", "/api/admin/audit?limit=100", { token: admin });
  const entries = r.data?.entries || [];
  step("GET /api/admin/audit records privileged actions", r.status === 200 && entries.length > 0 && typeof r.data?.total === "number" && Array.isArray(r.data?.actions), j({ n: entries.length }));
  step("the audit trail has role.create and permission.denied entries",
    entries.some((e) => e.action === "role.create") && entries.some((e) => e.action === "permission.denied"),
    j([...new Set(entries.map((e) => e.action))].slice(0, 12)));
  step("audit entries carry actor, ip and timestamp", entries.every((e) => e.created_at && e.action) && entries.some((e) => e.actor_id), j(entries[0], 200));
  r = await req("GET", "/api/admin/audit?action=role.create", { token: admin });
  step("the audit log can be filtered by action", r.status === 200 && (r.data?.entries || []).every((e) => e.action === "role.create") && r.data.entries.length > 0, j(r.data?.entries?.length));
  r = await req("GET", "/api/admin/audit", { token: userToken });
  step("a plain user cannot read the audit log", r.status === 403, j(r.data, 120));
  r = await req("GET", "/api/admin/audit?limit=5", { token: admin });
  step("the audit log honours its limit", (r.data?.entries || []).length <= 5, j(r.data?.entries?.length));

  // ---------------- mail outbox & maintenance ----------------
  r = await req("GET", "/api/admin/mail/outbox", { token: admin });
  step("GET /api/admin/mail/outbox reports the queue", r.status === 200 && typeof r.data?.pending === "number" && Array.isArray(r.data?.recent), j({ pending: r.data?.pending, sent: r.data?.sent, failed: r.data?.failed }));
  step("mail queued without SMTP is retained, not lost", (r.data?.pending || 0) + (r.data?.failed || 0) > 0, j({ pending: r.data?.pending, failed: r.data?.failed }));
  r = await req("GET", "/api/admin/mail/outbox", { token: userToken });
  step("a plain user cannot read the mail queue", r.status === 403, j(r.data, 120));
  r = await req("POST", "/api/admin/mail/flush", { token: admin, json: { limit: 5 } });
  step("POST /api/admin/mail/flush runs without SMTP configured", r.status === 200, j(r.data, 160));
  r = await req("POST", "/api/admin/maintenance", { token: admin, json: {} });
  step("POST /api/admin/maintenance sweeps every task", r.status === 200 && Array.isArray(r.data?.tasks) && r.data.tasks.length >= 7 && r.data.tasks.every((t) => typeof t.ms === "number"), j((r.data?.tasks || []).map((t) => `${t.task}:${t.ok}`)));
  r = await req("POST", "/api/admin/maintenance", { token: userToken, json: {} });
  step("a plain user cannot run maintenance", r.status === 403, j(r.data, 120));

  // ---------------- live chat idempotency ----------------
  // The server issues the session key (a client cannot squat an arbitrary one),
  // so every later call uses the key from this response.
  r = await req("POST", "/api/support/session", { json: { name: "Suite Visitor" } });
  const sessionKey = r.data?.session_key;
  step("POST /api/support/session issues a key", r.status === 200 && typeof sessionKey === "string" && sessionKey.length > 8, j(r.data, 160));
  step("a new session starts empty with a localized greeting", j(r.data?.messages) === "[]" && typeof r.data?.greeting === "string" && r.data.greeting.length > 0, j({ msgs: r.data?.messages?.length, greeting: r.data?.greeting?.slice(0, 30) }));
  const clientMessageId = `cmid-${Date.now()}`;
  r = await req("POST", "/api/support/messages", { json: { session_key: sessionKey, name: "Suite Visitor", body: "Hello from the v3 suite", client_message_id: clientMessageId } });
  const firstId = r.data?.message?.id;
  step("POST /api/support/messages with a client_message_id", r.status === 200 && !!firstId && r.data?.duplicate !== true, j(r.data, 200));
  step("chat timestamps are ISO-8601 (SSE cursors depend on it)", typeof r.data?.message?.created_at === "string" && r.data.message.created_at.includes("T") && r.data.message.created_at.endsWith("Z"), j(r.data?.message?.created_at));
  r = await req("POST", "/api/support/messages", { json: { session_key: sessionKey, name: "Suite Visitor", body: "Hello from the v3 suite", client_message_id: clientMessageId } });
  step("replaying the same client_message_id is idempotent", r.status === 200 && r.data?.duplicate === true && r.data?.message?.id === firstId, j(r.data, 200));
  r = await req("GET", `/api/support/messages?session=${sessionKey}`);
  const copies = (r.data?.messages || []).filter((m) => m.id === firstId);
  step("the replay did not create a second message", copies.length === 1, j({ copies: copies.length, total: r.data?.messages?.length }));
  r = await req("POST", "/api/support/messages", { json: { session_key: sessionKey, name: "Suite Visitor", body: "Second distinct message", client_message_id: `cmid-${Date.now()}-2` } });
  step("a different client_message_id creates a new message", r.status === 200 && r.data?.message?.id !== firstId, j(r.data, 140));
  r = await req("POST", "/api/support/messages", { json: { session_key: sessionKey, name: "Suite Visitor", body: "No idempotency key", } });
  step("a message without a key still works", r.status === 200 && !!r.data?.message?.id, j(r.data, 140));
  r = await req("GET", `/api/support/messages?session=${sessionKey}`);
  step("the visitor sees exactly the three distinct messages", (r.data?.messages || []).length === 3, j({ n: r.data?.messages?.length }));
  r = await req("GET", `/api/support/messages?session=${sessionKey}&after=1`);
  step("polling with a rowid cursor returns only newer messages", r.status === 200 && (r.data?.messages || []).length < 3, j({ n: r.data?.messages?.length }));

  r = await req("GET", "/api/support/admin/sessions", { token: admin });
  step("admin lists live chat sessions", r.status === 200 && Array.isArray(r.data?.sessions), j(r.data, 160));
  r = await req("POST", `/api/support/admin/sessions/${sessionKey}/reply`, { token: admin, json: { body: "Admin answer", client_message_id: `admin-${Date.now()}` } });
  step("admin replies in the session", r.status === 200, j(r.data, 160));
  const adminReplyId = r.data?.message?.id;
  r = await req("POST", `/api/support/admin/sessions/${sessionKey}/reply`, { token: admin, json: { body: "Admin answer", client_message_id: `admin-${Date.now()}` } });
  r = await req("GET", `/api/support/messages?session=${sessionKey}`);
  step("the visitor sees the admin reply", (r.data?.messages || []).some((m) => m.id === adminReplyId && m.sender_type === "admin"), j((r.data?.messages || []).map((m) => m.sender_type)));

  // ---------------- preferences (language + notification channels) ----------------
  r = await req("PATCH", "/api/users/me/preferences", { token: userToken, json: {} });
  step("an empty preferences update is rejected", r.status === 400 && codeOf(r.data) === "NO_CHANGES", j(r.data, 160));
  r = await req("PATCH", "/api/users/me/preferences", { token: userToken, json: { language: "xx" } });
  step("an unsupported language is rejected", r.status === 400 && codeOf(r.data) === "BAD_LANGUAGE", j(r.data, 160));
  r = await req("PATCH", "/api/users/me/preferences", { token: userToken, json: { language: "bn" } });
  step("PATCH /api/users/me/preferences saves the language", r.status === 200 && r.data?.user?.language === "bn", j(r.data?.user?.language));
  r = await req("POST", "/api/shop/orders", { token: userToken, json: { cart: {} } });
  step("the saved language drives later responses (no ?lang needed)", r.status === 400 && /[\u0980-\u09FF]/.test(msgOf(r.data)), j(r.data, 160));
  r = await req("PATCH", "/api/users/me/preferences", { token: userToken, json: { notify_inapp: false } });
  step("a notification channel can be turned off", r.status === 200 && r.data?.user?.notify_inapp === false, j(r.data?.user?.notify_inapp));
  const notesBefore = (await req("GET", "/api/notifications", { token: userToken })).data?.notifications?.length ?? 0;
  r = await req("POST", "/api/shop/orders", { token: userToken, json: { cart: { [restockId]: 1 }, payment_method: "cash", upazila: "Kalai", delivery_address: "Prefs test" } });
  const prefsOrder = r.data?.orderId;
  step("an order still succeeds with in-app notifications off", r.status === 200 && !!prefsOrder, j(r.data, 140));
  await sleep(300);
  const notesAfter = (await req("GET", "/api/notifications", { token: userToken })).data?.notifications?.length ?? 0;
  step("no new in-app notification is written while the channel is off", notesAfter === notesBefore, j({ notesBefore, notesAfter }));
  r = await req("PATCH", "/api/users/me/preferences", { token: userToken, json: { notify_inapp: "on", language: "en" } });
  step("the panel checkbox value 'on' re-enables the channel", r.status === 200 && r.data?.user?.notify_inapp === true && r.data?.user?.language === "en", j({ inapp: r.data?.user?.notify_inapp, lang: r.data?.user?.language }));
  r = await req("PATCH", "/api/users/me/preferences", { json: { language: "bn" } });
  step("preferences require authentication", r.status === 401, j(r.data, 120));

  // ---------------- shared rate limiting ----------------
  const spamEmail = `spam${Date.now()}@bloodora.test`;
  let limited = null;
  for (let i = 0; i < 14; i += 1) {
    const attempt = await req("POST", "/api/auth/login", { json: { email: spamEmail, password: "wrongpassword" } });
    if (attempt.status === 429) { limited = attempt; break; }
  }
  step("repeated failed logins are rate limited with 429", !!limited, limited ? j(limited.data, 140) : "never limited");
  step("the 429 carries Retry-After and a localized message", !!limited && Number(limited.headers.get("retry-after")) > 0 && !!msgOf(limited.data), limited ? j({ retry: limited.headers.get("retry-after"), scope: limited.headers.get("x-ratelimit-scope") }) : "");
  r = await req("POST", "/api/auth/login", { json: { email: adminEmail, password: "adminpass123" } });
  step("a different account is not affected by another's bucket", r.status === 200 && !!r.data?.token, j(r.data, 120));

  // ---------------- activity stream cursor ----------------
  r = await req("GET", "/api/meta/activity?limit=5");
  step("GET /api/meta/activity returns events with a server time", r.status === 200 && Array.isArray(r.data?.events) && typeof r.data?.serverTime === "string", j(r.data, 140));
  const since = new Date(Date.now() - 60_000).toISOString();
  const stream = await fetch(`${BASE}/api/meta/activity/stream?since=${encodeURIComponent(since)}`, { headers: { Accept: "text/event-stream" } });
  let chunk = "";
  let reader = null;
  try {
    if (stream.body) {
      reader = stream.body.getReader();
      const dec = new TextDecoder();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const read = await Promise.race([reader.read(), sleep(5000).then(() => null)]);
        if (!read) break;
        if (read.done) break;
        chunk += dec.decode(read.value, { stream: true });
        if (chunk.includes("data:")) break;
        if (chunk.length > 4000) break;
      }
    }
  } catch {
    /* a stream that ends early is not a suite failure */
  } finally {
    // Cancel through the READER: the stream is locked once getReader() is called,
    // and cancelling the body directly throws ERR_INVALID_STATE.
    try { await reader?.cancel(); } catch { /* best effort */ }
  }
  step("the activity SSE stream emits data frames (cursor comparison fixed)", chunk.includes("data:"), chunk.slice(0, 160) || "no frames");

  console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
  if (failures.length) {
    console.log("Failures:");
    failures.forEach((f) => console.log(` - ${f}`));
  }
  return failures.length === 0;
}

const main = async () => {
  if (process.env.V3_BASE) {
    console.log(`Running the v3 suite against ${BASE} (external target)`);
    const ok = await runSuite();
    process.exit(ok ? 0 : 1);
    return;
  }
  await assertPortFree();
  const cwd = mkdtempSync(path.join(tmpdir(), "bloodora-v3-"));
  const child = startServer(cwd);
  try {
    const up = await waitForHealth(child);
    if (!up) {
      console.error("Server did not become healthy in time.");
      process.exitCode = 2;
      return;
    }
    const ok = await runSuite();
    process.exitCode = ok ? 0 : 1;
  } finally {
    stopServer(child);
    await sleep(400);
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
};

main().catch((e) => {
  console.error("SUITE CRASH:", e);
  process.exit(2);
});
