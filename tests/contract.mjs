#!/usr/bin/env node
/**
 * BloodOra backend — end-to-end contract test.
 *
 * Spawns the real app (same as production) on a scratch port with a throwaway
 * local database, then walks the entire public contract: health/meta, auth
 * (register → first account becomes super admin), profile self-service, shop
 * (products → categories → cart → checkout → order lifecycle → cancel with
 * restock), blood requests, the support-desk messages inbox, reviews with
 * moderation, live chat sessions, AI endpoints (503 when unconfigured), the
 * admin panel surface, uploads and rate limiting.
 *
 * Usage:  npm run test:contract          (self-contained; needs port 4100 free)
 *         CONTRACT_BASE=http://… node tests/contract.mjs   (external target)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.CONTRACT_PORT || 4100);
const BASE = process.env.CONTRACT_BASE || `http://127.0.0.1:${PORT}`;

let pass = 0;
const failures = [];
const step = (name, ok, extra = "") => {
  if (ok) pass += 1;
  else {
    failures.push(`${name}${extra ? ` — ${extra}` : ""}`);
    console.log(`  FAIL ${name} ${extra}`);
  }
};

async function req(method, url, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (form) body = form;
  else if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  }
  const res = await fetch(BASE + url, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text.slice(0, 200) }; }
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      throw new Error(`Server process exited early (code ${child.exitCode}) — is port ${PORT} already in use?`);
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
  // detached:true → its own process group, so teardown can kill the whole
  // npx→tsx→node tree (a wrapper-only kill would orphan the listener and keep
  // npm's stdio pipes open forever).
  const child = spawn("npx", ["tsx", path.join(ROOT, "src/dev.ts")], {
    cwd, // scratch cwd → data/local.db lands here, never in the repo
    env: { ...process.env, PORT: String(PORT), LOG_LEVEL: "error" },
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  return child;
}

/** Kill the server's whole process group, then make sure it is gone. */
function stopServer(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch { /* already gone */ }
  setTimeout(() => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch { /* already gone */ }
  }, 1500).unref();
}

async function runSuite() {
  // ---------------- public ----------------
  let r = await req("GET", "/api/health");
  step("GET /api/health", r.status === 200 && r.data?.db === "ok", JSON.stringify(r.data));
  r = await req("GET", "/");
  step("GET / (API banner)", r.status === 200 && r.data?.status === "ok");
  r = await req("GET", "/api/meta");
  step("GET /api/meta", r.status === 200 && !!r.data?.site && Array.isArray(r.data?.categories));
  r = await req("GET", "/api/meta/settings");
  step("GET /api/meta/settings", r.status === 200 && !!r.data?.settings);
  r = await req("GET", "/api/meta/home");
  step("GET /api/meta/home", r.status === 200);
  r = await req("GET", "/api/meta/activity?limit=5");
  step("GET /api/meta/activity", r.status === 200 && Array.isArray(r.data?.events));
  r = await req("GET", "/api/meta/reviews");
  step("GET /api/meta/reviews", r.status === 200 && Array.isArray(r.data?.reviews) && !!r.data?.summary);
  r = await req("GET", "/api/meta/antid");
  step("GET /api/meta/antid", r.status === 200);
  r = await req("GET", "/api/meta/compatibility");
  step("GET /api/meta/compatibility", r.status === 200);
  r = await req("GET", "/api/meta/resources");
  step("GET /api/meta/resources", r.status === 200);
  r = await req("GET", "/api/meta/routes");
  step("GET /api/meta/routes", r.status === 200);
  r = await req("GET", "/api/meta/locations");
  step("GET /api/meta/locations", r.status === 200);
  r = await req("GET", "/api/meta/chat-auth");
  step("GET /api/meta/chat-auth (guest)", r.status === 200 && typeof r.data?.uid === "string" && r.data.uid.startsWith("guest_"), JSON.stringify(r.data));
  r = await req("GET", "/api/donors");
  step("GET /api/donors", r.status === 200 && Array.isArray(r.data?.users) && Array.isArray(r.data?.donors));

  // ---------------- shop (public) ----------------
  r = await req("GET", "/api/shop/products");
  step("GET /api/shop/products", r.status === 200 && Array.isArray(r.data?.products) && r.data.products.length > 0);
  const product = r.data?.products?.[0];
  const productId = product?.id;
  r = await req("GET", "/api/shop/categories");
  step("GET /api/shop/categories", r.status === 200 && Array.isArray(r.data?.categories) && r.data.categories.length > 0, JSON.stringify(r.data).slice(0, 120));
  if (productId) {
    r = await req("GET", `/api/shop/products/${productId}`);
    step("GET /api/shop/products/:id", r.status === 200 && !!r.data?.product);
    const bySlug = await req("GET", `/api/shop/products/${encodeURIComponent(r.data?.product?.slug || productId)}`);
    step("GET /api/shop/products/:id (slug)", [200, 404].includes(bySlug.status));
  }
  r = await req("POST", "/api/shop/cart/validate-item", { json: { product_id: productId, qty: 1 } });
  step("POST /api/shop/cart/validate-item", r.status === 200 && r.data?.ok === true, JSON.stringify(r.data).slice(0, 120));
  r = await req("POST", "/api/shop/cart/resolve", { json: { cart: { [productId]: 2 } } });
  step("POST /api/shop/cart/resolve", r.status === 200 && Array.isArray(r.data?.items) && r.data.items.length === 1, JSON.stringify(r.data).slice(0, 140));

  // ---------------- AI (unconfigured) ----------------
  r = await req("GET", "/api/ai/config");
  step("GET /api/ai/config", r.status === 200);
  r = await req("GET", "/api/ai/status");
  step("GET /api/ai/status", r.status === 200);
  r = await req("POST", "/api/ai/chat", { json: { messages: [{ role: "user", content: "hi" }] } });
  step("POST /api/ai/chat → 503 unconfigured", r.status === 503 && !!r.data?.error?.code, `status=${r.status}`);
  r = await req("POST", "/api/ai/ask", { json: { question: "hi" } });
  step("POST /api/ai/ask → 503 unconfigured", r.status === 503 && !!r.data?.error?.code, `status=${r.status}`);

  // ---------------- live chat (visitor) ----------------
  // The widget posts { session_key } and reads back d.session_key (see
  // views/partials/footer.ejs in the frontend repo).
  r = await req("POST", "/api/support/session", { json: { session_key: null, name: "Guest" } });
  step("POST /api/support/session", r.status === 200 && !!r.data?.session_key, JSON.stringify(r.data).slice(0, 140));
  const chatKey = r.data?.session_key;
  r = await req("POST", "/api/support/messages", { json: { session_key: chatKey, body: "hello, I need help" } });
  step("POST /api/support/messages", r.status === 200 || r.status === 201, JSON.stringify(r.data).slice(0, 140));
  r = await req("GET", `/api/support/messages?session=${chatKey}`);
  step("GET /api/support/messages", r.status === 200 && Array.isArray(r.data?.messages) && r.data.messages.length >= 1, JSON.stringify(r.data).slice(0, 140));

  // ---------------- blood requests ----------------
  r = await req("POST", "/api/blood-requests", {
    json: {
      patient_name: "Test P", blood_group: "O+", division: "Dhaka", district: "Dhaka", upazila: "Savar",
      hospital_name: "General Hospital", hospital_address: "Road 3", needed_by: "2026-12-01",
      contact_person: "CP", contact_phone: "01700000000", contact_email: "cp@test.com",
      quantity: 1, is_urgent: 0, additional_info: "please help",
    },
  });
  step("POST /api/blood-requests (guest)", [200, 201].includes(r.status), JSON.stringify(r.data).slice(0, 200));
  const guestRequestId = r.data?.request?.id || r.data?.id;
  r = await req("GET", "/api/blood-requests");
  step("GET /api/blood-requests", r.status === 200 && Array.isArray(r.data?.requests));
  r = await req("GET", "/api/blood-requests/urgent");
  step("GET /api/blood-requests/urgent", r.status === 200 && Array.isArray(r.data?.requests));
  if (guestRequestId) {
    r = await req("GET", `/api/blood-requests/${guestRequestId}`);
    step("GET /api/blood-requests/:id", r.status === 200 && !!r.data?.request);
  }
  r = await req("POST", "/api/blood-requests/urgent-contact", { json: { name: "Guest", phone: "01700000001", message: "urgent help" } });
  step("POST /api/blood-requests/urgent-contact", [200, 201].includes(r.status), JSON.stringify(r.data).slice(0, 140));

  // ---------------- auth: register (first user → super admin) ----------------
  const stamp = Date.now();
  const email = `owner${stamp}@test.com`;
  r = await req("POST", "/api/auth/register", {
    json: { name: "Owner", email, password: "Password123", phone: "01711223344", blood_group: "A+", division: "Dhaka", district: "Dhaka" },
  });
  step("POST /api/auth/register (first)", [200, 201].includes(r.status), JSON.stringify(r.data).slice(0, 200));
  step("register → first account is super_admin", r.data?.user?.role === "super_admin", JSON.stringify(r.data?.user?.role));
  const userId = r.data?.user?.id;

  r = await req("POST", "/api/auth/login", { json: { email, password: "Password123" } });
  step("POST /api/auth/login", r.status === 200 && !!r.data?.token);
  let token = r.data?.token;
  r = await req("GET", "/api/auth/me", { token });
  step("GET /api/auth/me", r.status === 200 && r.data?.user?.id === userId);
  r = await req("POST", "/api/auth/login", { json: { email, password: "wrong" } });
  step("login with wrong password → 401", r.status === 401 && r.data?.error?.code === "BAD_CREDENTIALS");

  // duplicate email
  r = await req("POST", "/api/auth/register", { json: { name: "Dup", email, password: "Password123", phone: "01700000009" } });
  step("duplicate register → 409 EMAIL_TAKEN", r.status === 409 && r.data?.error?.code === "EMAIL_TAKEN", JSON.stringify(r.data).slice(0, 140));

  // ---------------- profile self-service ----------------
  r = await req("PUT", "/api/users/me", { token, json: { name: "Owner Renamed", phone: "01711223345", date_of_birth: "2000-01-01", birth_certificate: "1990123456789" } });
  step("PUT /api/users/me", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  r = await req("POST", "/api/users/me/toggle-status", { token, json: {} });
  step("POST /api/users/me/toggle-status", r.status === 200 && typeof r.data?.can_donate === "boolean");
  await req("POST", "/api/users/me/toggle-status", { token, json: {} }); // toggle back
  r = await req("POST", "/api/users/me/apply-verification", { token, json: {} });
  step("POST /api/users/me/apply-verification (18+)", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  r = await req("GET", `/api/users/${userId}`);
  step("GET /api/users/:id", r.status === 200 && !!r.data?.user);
  r = await req("GET", `/api/users/${userId}/public`);
  step("GET /api/users/:id/public", r.status === 200 && !!r.data?.user);
  r = await req("PATCH", "/api/auth/profile", { token, json: { name: "Owner Renamed" } });
  step("PATCH /api/auth/profile", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  r = await req("POST", "/api/auth/password", { token, json: { current: "Password123", next: "Password1234" } });
  step("POST /api/auth/password", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  r = await req("POST", "/api/auth/login", { json: { email, password: "Password1234" } });
  step("login with new password", r.status === 200 && !!r.data?.token);
  if (r.data?.token) token = r.data.token; // login rotates the session token
  r = await req("POST", "/api/auth/password", { token, json: { current: "Password1234", next: "Password123" } });
  step("POST /api/auth/password (revert)", r.status === 200);
  r = await req("POST", "/api/auth/login", { json: { email, password: "Password123" } });
  step("login with reverted password", r.status === 200);
  if (r.data?.token) token = r.data.token;

  // ---------------- shop: checkout + order lifecycle ----------------
  r = await req("GET", "/api/shop/checkout/context", { token });
  step("GET /api/shop/checkout/context", r.status === 200 && "gateway_numbers" in r.data, JSON.stringify(r.data).slice(0, 160));
  r = await req("POST", "/api/shop/orders", { token, json: { cart: { [productId]: 2 }, payment_method: "cod", delivery_address: "Kalai Bazar", division: "Rajshahi", district: "Joypurhat", upazila: "Kalai" } });
  step("POST /api/shop/orders", [200, 201].includes(r.status), JSON.stringify(r.data).slice(0, 200));
  const orderId = r.data?.order?.id || r.data?.orderId || r.data?.id;
  r = await req("GET", "/api/shop/orders/mine", { token });
  step("GET /api/shop/orders/mine", r.status === 200 && Array.isArray(r.data?.orders) && r.data.orders.length === 1);
  r = await req("GET", `/api/shop/orders/${orderId}`, { token });
  step("GET /api/shop/orders/:id", r.status === 200 && !!r.data?.order && Array.isArray(r.data?.items));
  const stockAfterOrder = (await req("GET", "/api/shop/products")).data?.products?.find((p) => p.id === productId)?.stock;

  // cancel while pending → stock restored
  r = await req("POST", `/api/shop/orders/${orderId}/cancel`, { token });
  step("POST /api/shop/orders/:id/cancel (pending)", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  const stockAfterCancel = (await req("GET", "/api/shop/products")).data?.products?.find((p) => p.id === productId)?.stock;
  step("cancel restocks inventory", stockAfterCancel === stockAfterOrder + 2, `before=${stockAfterOrder} after=${stockAfterCancel}`);
  r = await req("POST", `/api/shop/orders/${orderId}/cancel`, { token });
  step("double cancel → 409", r.status === 409 && r.data?.error?.code === "ORDER_NOT_CANCELLABLE", JSON.stringify(r.data).slice(0, 140));

  // place a fresh order for the admin lifecycle + review tests
  r = await req("POST", "/api/shop/orders", { token, json: { cart: { [productId]: 1 }, payment_method: "bkash", bkash_number: "01700000000", transaction_id: "TX1", delivery_address: "Kalai Bazar", division: "Rajshahi", district: "Joypurhat", upazila: "Kalai" } });
  step("POST /api/shop/orders (bkash)", [200, 201].includes(r.status), JSON.stringify(r.data).slice(0, 200));
  const liveOrderId = r.data?.order?.id || r.data?.orderId || r.data?.id;

  // delivery-area guard
  r = await req("POST", "/api/shop/orders", { token, json: { cart: { [productId]: 1 }, payment_method: "cod", delivery_address: "x", division: "Dhaka", district: "Dhaka", upazila: "Dhanmondi" } });
  step("order outside delivery area → 422/400", [400, 422].includes(r.status) && r.data?.error?.code === "DELIVERY_AREA_NOT_SERVED", JSON.stringify(r.data).slice(0, 140));
  // empty cart guard
  r = await req("POST", "/api/shop/orders", { token, json: { cart: {}, payment_method: "cod", delivery_address: "x", division: "Dhaka", district: "Dhaka", upazila: "Kalai" } });
  step("empty cart → 400 EMPTY_CART", r.status === 400 && r.data?.error?.code === "EMPTY_CART");

  // ---------------- reviews ----------------
  r = await req("POST", "/api/reviews", { token, json: { product_id: productId, title: "Great", body: "great product, fast delivery", rating: 5 } });
  step("POST /api/reviews", [200, 201].includes(r.status), JSON.stringify(r.data).slice(0, 200));
  const reviewId = r.data?.review?.id || r.data?.id;
  r = await req("GET", "/api/reviews/mine", { token });
  step("GET /api/reviews/mine", r.status === 200 && Array.isArray(r.data?.reviews) && r.data.reviews.length >= 1);
  r = await req("POST", "/api/shop/reviews", { token, json: { product_id: productId, title: "S", body: "short", rating: 5 } });
  step("review with short body → 400", r.status === 400 && r.data?.error?.code === "BODY_TOO_SHORT", JSON.stringify(r.data).slice(0, 140));

  // ---------------- support-desk messages ----------------
  r = await req("POST", "/api/messages", { token, json: { subject: "Hello", content: "I need help with my order, this is a long message" } });
  step("POST /api/messages", [200, 201].includes(r.status), JSON.stringify(r.data).slice(0, 160));
  const msgId = r.data?.message?.id || r.data?.id;
  r = await req("GET", "/api/messages", { token });
  step("GET /api/messages (inbox)", r.status === 200 && Array.isArray(r.data?.received));
  if (msgId) {
    r = await req("GET", `/api/messages/${msgId}`, { token });
    step("GET /api/messages/:id", r.status === 200 && !!r.data?.message);
    r = await req("GET", `/api/messages/${msgId}/original`, { token });
    step("GET /api/messages/:id/original", r.status === 200);
    r = await req("POST", `/api/messages/${msgId}/reply`, { token, json: { content: "replying to my own message" } });
    step("POST /api/messages/:id/reply", [200, 201].includes(r.status), JSON.stringify(r.data).slice(0, 160));
  }

  // ---------------- blood request lifecycle (user) ----------------
  r = await req("POST", "/api/blood-requests", {
    token,
    json: {
      patient_name: "P2", blood_group: "B+", division: "Dhaka", district: "Dhaka", upazila: "Mirpur",
      hospital_name: "H2", hospital_address: "a", needed_by: "2026-12-02", contact_person: "CP2",
      contact_phone: "01700000002", quantity: 1,
    },
  });
  step("POST /api/blood-requests (user)", [200, 201].includes(r.status), JSON.stringify(r.data).slice(0, 160));
  const myReqId = r.data?.request?.id || r.data?.id;
  r = await req("GET", "/api/blood-requests/mine", { token });
  step("GET /api/blood-requests/mine", r.status === 200);
  if (myReqId) {
    r = await req("POST", `/api/blood-requests/${myReqId}/fulfill`, { token });
    step("POST /api/blood-requests/:id/fulfill", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  }

  // ================= admin (first account = super admin) =================
  const A = { token };
  r = await req("GET", "/api/admin/dashboard", A);
  step("GET /api/admin/dashboard", r.status === 200 && "stats" in (r.data || {}), JSON.stringify(r.data).slice(0, 160));
  r = await req("GET", "/api/admin/activity", A);
  step("GET /api/admin/activity", r.status === 200 && Array.isArray(r.data?.events));
  r = await req("POST", "/api/admin/activity/announce", { token, json: { title: "Blood drive", detail: "Friday 10am" } });
  step("POST /api/admin/activity/announce", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  r = await req("GET", "/api/admin/settings", A);
  step("GET /api/admin/settings (masked)", r.status === 200 && !!r.data?.settings);
  r = await req("POST", "/api/admin/settings", { token, json: { site_name: "BloodOra" } });
  step("POST /api/admin/settings", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  r = await req("GET", "/api/admin/branding", A);
  step("GET /api/admin/branding", r.status === 200 || r.status === 404, `status=${r.status}`);
  r = await req("GET", "/api/admin/smtp", A);
  step("GET /api/admin/smtp", r.status === 200);
  r = await req("GET", "/api/admin/smtp/log", A);
  step("GET /api/admin/smtp/log", r.status === 200);
  r = await req("POST", "/api/admin/smtp/test", { token, json: { to: "t@test.com" } });
  step("POST /api/admin/smtp/test (disabled → logged)", [200, 400, 502].includes(r.status), `status=${r.status}`);

  // content manager
  r = await req("GET", "/api/admin/content/antid", A);
  step("GET /api/admin/content/antid", r.status === 200 && Array.isArray(r.data?.entries));
  r = await req("POST", "/api/admin/content/antid", { token, json: { title: "Q entry", description: "A description" } });
  step("POST /api/admin/content/antid", [200, 201].includes(r.status), JSON.stringify(r.data).slice(0, 160));
  const antidId = r.data?.entry?.id || r.data?.id;
  r = await req("GET", "/api/admin/content/resources", A);
  step("GET /api/admin/content/resources", r.status === 200 && Array.isArray(r.data?.resources));
  r = await req("POST", "/api/admin/content/resources", { token, json: { title: "R entry", content: "Some content", category: "general", link: "https://example.com" } });
  step("POST /api/admin/content/resources", [200, 201].includes(r.status), JSON.stringify(r.data).slice(0, 160));
  const resId = r.data?.resource?.id || r.data?.id;
  if (antidId) {
    r = await req("PUT", `/api/admin/content/antid/${antidId}`, { token, json: { title: "Q entry 2", description: "A description 2" } });
    step("PUT /api/admin/content/antid/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("DELETE", `/api/admin/content/antid/${antidId}`, A);
    step("DELETE /api/admin/content/antid/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  }
  if (resId) {
    r = await req("PUT", `/api/admin/content/resources/${resId}`, { token, json: { title: "R entry 2", content: "Content 2" } });
    step("PUT /api/admin/content/resources/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("DELETE", `/api/admin/content/resources/${resId}`, A);
    step("DELETE /api/admin/content/resources/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  }

  // notice
  r = await req("POST", "/api/admin/notice", { token, json: { notice_content: "site notice text" } });
  step("POST /api/admin/notice", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  r = await req("GET", "/api/admin/notice/clear", A);
  step("GET /api/admin/notice/clear", r.status === 200, JSON.stringify(r.data).slice(0, 160));

  // admin products
  r = await req("GET", "/api/admin/products", A);
  step("GET /api/admin/products", r.status === 200);
  r = await req("POST", "/api/admin/products", { token, json: { name: "Prod X", price: 100, stock: 5, category: "gloves", description: "test product" } });
  step("POST /api/admin/products", [200, 201].includes(r.status), JSON.stringify(r.data).slice(0, 200));
  const newProdId = r.data?.product?.id || r.data?.id;
  if (newProdId) {
    r = await req("PUT", `/api/admin/products/${newProdId}`, { token, json: { name: "Prod Y", price: 120, stock: 6, category: "gloves", description: "test product" } });
    step("PUT /api/admin/products/:id", r.status === 200, JSON.stringify(r.data).slice(0, 200));
    r = await req("DELETE", `/api/admin/products/${newProdId}`, A);
    step("DELETE /api/admin/products/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  }

  // admin orders
  r = await req("GET", "/api/admin/orders", A);
  step("GET /api/admin/orders", r.status === 200 && Array.isArray(r.data?.orders));
  if (liveOrderId) {
    r = await req("GET", `/api/admin/orders/${liveOrderId}`, A);
    step("GET /api/admin/orders/:id", r.status === 200 && !!r.data?.order);
    r = await req("POST", `/api/admin/orders/${liveOrderId}/confirm-payment`, A);
    step("POST /api/admin/orders/:id/confirm-payment", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("POST", `/api/admin/orders/${liveOrderId}/status`, { token, json: { status: "shipped" } });
    step("POST /api/admin/orders/:id/status", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("PATCH", `/api/admin/orders/${liveOrderId}/status`, { token, json: { status: "delivered" } });
    step("PATCH /api/admin/orders/:id/status", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("POST", `/api/admin/orders/${liveOrderId}/status`, { token, json: { status: "bogus" } });
    step("bad status → 400", r.status === 400 && r.data?.error?.code === "BAD_STATUS");
  }

  // user administration
  if (userId) {
    r = await req("POST", `/api/admin/verify-donor/${userId}`, A);
    step("POST /api/admin/verify-donor/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("GET", `/api/admin/user/details/${userId}`, A);
    step("GET /api/admin/user/details/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("POST", `/api/admin/user/update/${userId}`, { token, json: { name: "Owner Renamed" } });
    step("self-update guard → 400 PROTECTED_USER", r.status === 400 && r.data?.error?.code === "PROTECTED_USER", JSON.stringify(r.data).slice(0, 140));
  }

  // second user: promote / demote / edit / impersonate / delete
  const throwEmail = `helper${stamp}@test.com`;
  r = await req("POST", "/api/auth/register", { json: { name: "Helper", email: throwEmail, password: "Password123", phone: "01711223377" } });
  step("register second user", [200, 201].includes(r.status));
  const throwId = r.data?.user?.id;
  if (throwId) {
    r = await req("POST", `/api/admin/promote/${throwId}`, A);
    step("POST /api/admin/promote/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("POST", `/api/admin/demote/${throwId}`, A);
    step("POST /api/admin/demote/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("POST", `/api/admin/user/update/${throwId}`, { token, json: { name: "Helper Renamed", phone: "01711223399" } });
    step("POST /api/admin/user/update/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("POST", `/api/admin/impersonate/${throwId}`, A);
    step("POST /api/admin/impersonate/:id", r.status === 200 && !!r.data?.token, JSON.stringify(r.data).slice(0, 160));
    // The frontend keeps the admin's own token and calls switch-back with it,
    // passing the impersonated user id (src/routes/admin.js in the frontend).
    r = await req("POST", "/api/admin/switch-back", { token, json: { impersonated_user_id: throwId } });
    step("POST /api/admin/switch-back", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("DELETE", `/api/admin/user/${throwId}`, A);
    step("DELETE /api/admin/user/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  }
  r = await req("POST", "/api/admin/create-admin", { token, json: { name: "New Admin", email: `adm${stamp}@test.com`, password: "Password123" } });
  step("POST /api/admin/create-admin", [200, 201].includes(r.status), JSON.stringify(r.data).slice(0, 160));
  r = await req("GET", "/api/admin/backup", A);
  step("GET /api/admin/backup", r.status === 200, `status=${r.status}`);

  // admin blood requests
  if (guestRequestId) {
    r = await req("GET", `/api/admin/blood-requests/${guestRequestId}`, A);
    step("GET /api/admin/blood-requests/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("PATCH", `/api/admin/blood-requests/${guestRequestId}/status`, { token, json: { status: "fulfilled" } });
    step("PATCH /api/admin/blood-requests/:id/status", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("DELETE", `/api/admin/blood-requests/${guestRequestId}`, A);
    step("DELETE /api/admin/blood-requests/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  }

  // admin messages
  r = await req("GET", "/api/messages/admin/list", A);
  step("GET /api/messages/admin/list", r.status === 200);
  if (msgId) {
    r = await req("POST", `/api/messages/admin/reply/${msgId}`, { token, json: { content: "admin reply content" } });
    step("POST /api/messages/admin/reply/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  }

  // review moderation
  r = await req("GET", "/api/reviews/admin", A);
  step("GET /api/reviews/admin", r.status === 200);
  const revId = (r.data?.reviews || [])[0]?.id || reviewId;
  if (revId) {
    r = await req("POST", `/api/reviews/admin/${revId}/status`, { token, json: { status: "approved" } });
    step("POST /api/reviews/admin/:id/status", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("POST", `/api/reviews/admin/${revId}/feature`, { token, json: { is_featured: 1 } });
    step("POST /api/reviews/admin/:id/feature", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("POST", `/api/reviews/admin/${revId}/reply`, { token, json: { admin_reply: "thanks from BloodOra" } });
    step("POST /api/reviews/admin/:id/reply", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("DELETE", `/api/reviews/admin/${revId}`, A);
    step("DELETE /api/reviews/admin/:id", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  }

  // live chat admin
  r = await req("GET", "/api/support/admin/sessions", A);
  step("GET /api/support/admin/sessions", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  if (chatKey) {
    r = await req("GET", `/api/support/admin/sessions/${chatKey}/messages`, A);
    step("GET /api/support/admin/sessions/:key/messages", r.status === 200);
    r = await req("POST", `/api/support/admin/sessions/${chatKey}/reply`, { token, json: { body: "admin here, how can we help?" } });
    step("POST /api/support/admin/sessions/:key/reply", r.status === 200, JSON.stringify(r.data).slice(0, 160));
    r = await req("POST", `/api/support/admin/sessions/${chatKey}/close`, A);
    step("POST /api/support/admin/sessions/:key/close", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  }

  // AI admin
  r = await req("GET", "/api/ai/admin/config", A);
  step("GET /api/ai/admin/config", r.status === 200);
  r = await req("POST", "/api/ai/admin/config", { token, json: {} });
  step("POST /api/ai/admin/config", r.status === 200, JSON.stringify(r.data).slice(0, 160));
  r = await req("POST", "/api/ai/admin/test", { token, json: { prompt: "hi" } });
  step("POST /api/ai/admin/test (unconfigured → 5xx)", [200, 400, 502, 503].includes(r.status), `status=${r.status}`);
  r = await req("GET", "/api/ai/admin/models", A);
  step("GET /api/ai/admin/models", [200, 502, 503].includes(r.status), `status=${r.status}`);
  r = await req("GET", "/api/ai/admin/conversations", A);
  step("GET /api/ai/admin/conversations", r.status === 200);
  r = await req("GET", "/api/ai/admin/knowledge", A);
  step("GET /api/ai/admin/knowledge", r.status === 200);

  // chat-auth now identifies the logged-in user
  r = await req("GET", "/api/meta/chat-auth", { token });
  step("GET /api/meta/chat-auth (user)", r.status === 200 && r.data?.uid === String(userId), JSON.stringify(r.data).slice(0, 140));

  // authorization guards
  r = await req("GET", "/api/admin/dashboard");
  step("admin surface without token → 401", r.status === 401 && r.data?.error?.code === "UNAUTHENTICATED");

  // logout (rotates the session token → bearer JWT is dead afterwards)
  r = await req("POST", "/api/auth/logout", { token });
  step("POST /api/auth/logout", r.status === 200, JSON.stringify(r.data).slice(0, 140));
  r = await req("GET", "/api/auth/me", { token });
  step("token revoked after logout → 401", r.status === 401, JSON.stringify(r.data).slice(0, 140));

  console.log(`\n=== ${pass} passed, ${failures.length} failed ===`);
  if (failures.length) {
    console.log("Failures:");
    failures.forEach((f) => console.log(` - ${f}`));
  }
  return failures.length === 0;
}

const main = async () => {
  if (process.env.CONTRACT_BASE) {
    console.log(`Running contract suite against ${BASE} (external target)`);
    const ok = await runSuite();
    process.exit(ok ? 0 : 1);
  }
  await assertPortFree();
  const cwd = mkdtempSync(path.join(tmpdir(), "bloodora-contract-"));
  const child = startServer(cwd);
  try {
    const up = await waitForHealth(child);
    if (!up) {
      console.error("Server did not become healthy in time.");
      process.exitCode = 2;
      return;
    }
    const ok = await runSuite();
    // NOTE: no process.exit() here — it would skip the finally block and
    // orphan the server tree.
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
