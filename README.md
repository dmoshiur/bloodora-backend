# BloodOra Backend

Production backend for **BloodOra** — blood donation, blood requests, medical
supplies shop, orders, live chat and Live AI Help.

**Stack:** Node.js ≥ 18 · TypeScript (strict, ESM/NodeNext) · Express 4 ·
Turso/libSQL (`@libsql/client`) · express-session (Turso-backed store) ·
zod · multer · nodemailer · Groq (OpenAI-compatible) · Vercel Functions.

```
Frontend (dmoshiur/lspk)  →  HTTPS  →  /api/*  →  routes → controllers
   → services (business rules, ApiError) → repositories (all SQL) → db/query → Turso
```

Routes are thin (validation only); **no SQL or business logic in route files**.
Every table the frontend needs lives in the database — there is no in-process
cache of business state. The only per-instance state is a best-effort rate
limit window (documented in `src/middleware/rateLimit.ts`).

## Getting started (local)

```bash
cp .env.example .env      # leave TURSO_* empty → uses ./data/local.db (dev only)
npm install
npm run make-defaults     # generates uploads/*.png + src/data/defaults.ts (idempotent)
npm run dev               # http://0.0.0.0:4000  (same app as production + a server)
```

The first request runs an idempotent bootstrap: DDL → settings defaults →
product seeds → super-admin provisioning (see `src/db/init.ts`).

> The root-level `uploads/` folder is scratch space for `make-defaults` only —
> nothing on the request path reads it. It is ignored by git as **`/uploads/`**
> (anchored). An unanchored `uploads/` pattern also hides `src/uploads/`, which
> is real source (`src/uploads/uploads.ts`), so a fresh clone — i.e. every
> Vercel build — fails `tsc` with `TS2307 Cannot find module
> '../uploads/uploads.js'`.

## Deployment (Vercel serverless)

`vercel.json` compiles **`src/server.ts`** with `@vercel/node`. The file's
default export is the Express app itself (an Express app *is* a
`function(req, res)`), which is exactly what the Node runtime requires — this
fixes `Invalid export found in module /var/task/server.js — The default export
must be a function or server`. There is **no `app.listen()`** in the entry
point; `src/dev.ts` is the only place a server is owned.

Required environment variables (all backend-only, never sent to the frontend):

| Var | Purpose |
| --- | --- |
| `TURSO_DATABASE_URL` | `libsql://…` remote database (required in prod) |
| `TURSO_AUTH_TOKEN` | Turso auth token (required in prod) |
| `JWT_SECRET` | signs session JWTs (required in prod) |
| `FRONTEND_URL` | comma-separated CORS allow-list (required in prod) |
| `COOKIE_DOMAIN` | optional shared cookie domain |
| `SUPER_ADMIN_EMAIL/PASSWORD/NAME/PHONE` | idempotent super-admin bootstrap |
| `MAX_UPLOAD_MB` | optional per-image upload cap (default `4`; Vercel rejects request bodies over 4.5 MB) |
| `GROQ_API_KEY`, `AI_*` | Live AI Help (admin panel can override) |
| `SMTP_*` | transactional mail (admin panel can override; skip-logged when off) |

Production boot **fails fast** if any required variable is missing
(`src/config/env.ts`). Set these values in the Vercel project settings for the
**Production** environment; a `.env` file on your computer is not uploaded by
Vercel.

### Deployment smoke checks

The app exposes two intentionally simple probes:

```bash
curl -i https://YOUR_PUBLIC_BACKEND_DOMAIN/
# 200: {"name":"bloodora-backend","status":"ok",...}

curl -i https://YOUR_PUBLIC_BACKEND_DOMAIN/api/health
# 200 + db:"ok" when Turso is reachable; 503 + db:"error" otherwise
```

`/` and `/health` only check that the function is reachable. `/api/health` also
performs a live database query. If curl returns a Vercel login page or a 401
before these JSON responses, the request is being stopped by **Vercel
Deployment Protection**, not by Express. Use the public production domain (not
the long preview/deployment URL), or set Vercel → Project Settings →
Deployment Protection to leave the production domain public. If a protected
preview must be tested from curl/CI, use Vercel's protection-bypass header; do
not put that bypass secret in this repository or in frontend code.

The backend's production `FRONTEND_URL` is a comma-separated list of frontend
origins. Trailing slashes are normalized, for example
`https://bloodora.example,https://www.bloodora.example/`.

Vercel runs `npm run build` (`tsc`) before bundling the function, so **every
file under `src/` must be committed** — a source file hidden by `.gitignore`
builds fine locally and fails the deploy with `TS2307`. Note also that
`tsconfig.json` pins `types: ["node", "multer"]`: once `types` is set,
TypeScript stops auto-loading `@types/*`, and `@types/multer` is what declares
the global `Express.Multer.File` namespace used by `admin.controller.ts`
(`TS2694` without it).

`helmet` is imported as a **namespace** in `src/app.ts` and its callable member
is picked explicitly. helmet ships dual ESM/CJS builds whose declarations expose
the middleware *only* as a default export, so which one a compiler binds depends
on its resolution mode: this repo's `NodeNext` config takes `index.d.mts` (the
callable default), while a CJS-oriented compile — such as the function-bundling
step — takes `index.d.cts`, where a default import binds to the whole
`module.exports` namespace and fails with
`TS2349: This expression is not callable. Type 'typeof import("…/helmet/index")'
has no call signatures`. The namespace form type-checks under both and is the
same function at runtime either way.

## Security model

- **Sessions** — `express-session` with `TursoSessionStore`
  (`src/sessions/tursoStore.ts`): every session row lives in the `sessions`
  table, so login state survives cold starts and works across instances.
  The session cookie `connect.sid` is `httpOnly`, `sameSite=lax`,
  `secure` in production.
- **Auth** — each login mints a JWT `{uid, sid, adm}` stored in the session
  (cookie path) or returned in the response body (bearer path). On **every**
  request the token's `sid` is re-checked against `users.session_token`, so
  **logout revokes all tokens immediately**, including already-issued JWTs.
- **Authorization** — admin/super-admin role is re-read from the database on
  every admin request; JWT claims are never trusted alone. Super admins are
  protected from demotion/deletion by non-super-admins; self-demotion and
  self-delete are blocked.
- **CORS** — only origins listed in `FRONTEND_URL` are accepted; others get
  `403 CORS_NOT_ALLOWED` (handled centrally, not a 500).
- **Secrets** — SMTP password and AI API key are stored only in the DB
  `settings` table; the admin panel receives masked values (`••••••••`) and
  sends that marker back to keep them unchanged.
- **Orders** — order + line items + stock decrement run in a **single
  transaction** (`orderRepo.placeTx`); stock is re-checked inside the
  transaction so overselling produces `422 OUT_OF_STOCK`, never a ghost order
  or negative stock.
- **Uploads** — `src/uploads/uploads.ts` parses multipart bodies with multer's
  **memory** storage (a serverless filesystem is read-only and ephemeral):
  images only, a per-file size cap, random storage names (the client's file name
  is never used in a path or URL), and every `MulterError` mapped to the
  documented `400 UPLOAD_ERROR` instead of a `500`. Bytes are persisted into the
  `uploads` table by `uploadService` and streamed back by `GET /uploads/:file`;
  SVGs are served with `Content-Security-Policy: sandbox` so an embedded script
  gets an opaque origin instead of the API's.
- **Logging** — structured JSON, redacts `*secret/token/password/key/cookie*`
  fields, never logs request bodies; 5xx logs include stack + path.

## API overview

Base: `/api` — errors always return `{ error: { code, message, details? } }`.
This table is generated from `src/routes/*` — it is the contract the BloodOra
frontend (dmoshiur/lspk) calls, verified end-to-end by `npm run test:contract`.

### Public

| Method & path | Description |
| --- | --- |
| `GET /api/health` | liveness + real `SELECT 1` DB round-trip |
| `GET /api/meta` | site settings, categories, divisions, payment methods, delivery |
| `GET /api/meta/settings` · `/home` · `/locations` · `/routes` | page-level meta views |
| `GET /api/meta/activity?limit=` · `/activity/stream` | live activity feed (JSON + SSE) |
| `GET /api/meta/reviews?kind=&product_id=&rating=` | published reviews + summary |
| `GET /api/meta/antid` · `/compatibility` · `/resources` | static clinical/educational content |
| `GET /api/meta/chat-auth` | live-chat widget identity (guest id or account) |
| `GET /api/donors` | verified donor directory (`?bg=&dist=&upa=&age_min=`) |
| `GET /api/shop/products` · `/products/:id` | catalogue (id **or** slug) + approved reviews |
| `GET /api/shop/categories` | live category list with product counts |
| `POST /api/shop/cart/validate-item` | `{product_id, qty}` availability check |
| `POST /api/shop/cart/resolve` | `{cart: {id: qty}}` → priced items, stock guard |
| `GET /api/ai/config` · `/status` | Live AI Help availability (no secrets) |
| `POST /api/ai/chat` · `/ask` | AI chat (503 + friendly message when unconfigured) |
| `POST /api/support/session` | start/resume a live-chat thread (`{session_key}`) |
| `GET /api/support/messages?session=&after=` | poll thread messages |
| `POST /api/support/messages` | `{session_key, body}` visitor message |
| `GET /api/support/stream?session=` | visitor SSE channel |
| `GET /api/blood-requests` | public board (`?bg=&dist=&division=&urgent=`) |
| `GET /api/blood-requests/urgent` | urgent-only board |
| `GET /api/blood-requests/:id` | one request |
| `POST /api/blood-requests` | post request (guest or logged-in) |
| `POST /api/blood-requests/urgent-contact` | urgent-help contact form |
| `GET /api/users/:id` · `/:id/public` | public profile |
| `GET /uploads/:file` · `GET /api/uploads/:file` | serve stored image |

### Authenticated (user)

| Method & path | Description |
| --- | --- |
| `POST /api/auth/register` | create account — **first account becomes super admin** |
| `POST /api/auth/login` | login → `{user, token}` (rotates the session token, revoking older JWTs) |
| `POST /api/auth/logout` | rotate session token — revokes every issued JWT immediately |
| `GET /api/auth/me` | current user |
| `PATCH /api/auth/profile` | update name/email/phone/blood/city |
| `POST /api/auth/password` | `{current, next}` change password |
| `POST /api/auth/profile/image` | multipart `image` → profile picture |
| `PUT /api/users/me` | self-service profile edit (multipart, optional `profile_pic`) |
| `POST /api/users/me/toggle-status` | donation availability toggle |
| `POST /api/users/me/apply-verification` | 18+ gate, admin reviews afterwards |
| `GET /api/shop/checkout/context` | gateway numbers + saved wallet/address |
| `POST /api/shop/orders` | checkout — `{cart, payment_method, division, district, upazila, …}` (Kalai only), atomic stock deduction |
| `GET /api/shop/orders/mine` | my orders |
| `GET /api/shop/orders/:id` | owner (or admin) order + items |
| `POST /api/shop/orders/:id/cancel` | owner cancels while `pending` — stock restored in one transaction |
| `POST /api/reviews` · `POST /api/shop/reviews` | review a purchased product (`{title, body, rating, product_id}`, moderated) |
| `GET /api/reviews/mine` | my reviews |
| `POST /api/messages` | `{subject, content}` → support desk |
| `GET /api/messages` | inbox (`received`, `sent`, `unread_count`) |
| `GET /api/messages/:id` · `/:id/original` | read one message / original thread |
| `POST /api/messages/:id/reply` | `{content}` reply |
| `GET /api/blood-requests/mine` | my blood requests |
| `POST /api/blood-requests/:id/fulfill` · `/:id/cancel` | manage own request |
| `POST /api/uploads` | generic image upload (multipart `file`) |

### Admin

| Method & path | Description |
| --- | --- |
| `GET /api/admin/dashboard` | stats, recent orders/users, low stock |
| `GET /api/admin/activity` · `POST /api/admin/activity/announce` | live feed + `{title, detail, link}` announcement |
| `GET /api/admin/settings` · `POST` | site settings (secrets masked with `••••••••`) |
| `GET /api/admin/branding` · `POST` | logo/favicon (multipart) |
| `GET /api/admin/smtp` · `POST` · `/smtp/test` · `/smtp/log` | mail settings + test + send log |
| `GET/POST /api/admin/content/antid` · `PUT/DELETE /:id` | Anti-D content manager |
| `GET/POST /api/admin/content/resources` · `PUT/DELETE /:id` | resource manager |
| `POST /api/admin/notice` · `GET /api/admin/notice/clear` | site notice bar |
| `GET/POST /api/admin/products` · `PUT/DELETE /api/admin/products/:id` | product management (multipart `image`) |
| `GET /api/admin/orders` · `GET /:id` | orders (`?status=`) |
| `POST/PATCH /api/admin/orders/:id/status` | status lifecycle (cancel restocks) |
| `POST /api/admin/orders/:id/confirm-payment` | confirm payment |
| `GET /api/admin/blood-requests/:id` · `PATCH /:id/status` · `DELETE /:id` | moderate requests |
| `POST /api/admin/verify-donor/:id` | donor verification |
| `POST /api/admin/promote/:id` · `/demote/:id` | role management (super admin) |
| `GET /api/admin/user/details/:id` · `POST /api/admin/user/update/:id` · `DELETE /api/admin/user/:id` | user administration (self/super-admin guards) |
| `POST /api/admin/create-admin` | create an admin account (super admin) |
| `POST /api/admin/impersonate/:id` · `/switch-back` | support impersonation (`{impersonated_user_id}` to switch back) |
| `GET /api/admin/backup` | Turso backup notice |
| `GET /api/messages/admin/list` · `POST /api/messages/admin/reply/:id` | desk inbox + reply |
| `GET /api/reviews/admin` · `POST /:id/status` · `/:id/feature` · `/:id/reply` · `DELETE /:id` | review moderation |
| `GET /api/support/admin/sessions` · `/sessions/:key/messages` · `/sessions/:key/reply` · `/sessions/:key/close` · `/admin/stream` | live chat inbox |
| `GET/POST /api/ai/admin/config` · `/admin/test` · `/admin/models` · `/admin/conversations` · `/admin/knowledge` | AI assistant settings + transcripts |

### Error codes

| Status | Code (examples) |
| --- | --- |
| 400 | `VALIDATION_ERROR`, `BAD_JSON`, `BAD_BLOOD_GROUP`, `UPLOAD_ERROR`, `PROTECTED_USER` |
| 401 | `UNAUTHENTICATED`, `BAD_CREDENTIALS`, `SESSION_INVALID`, `LOGIN_REQUIRED` |
| 403 | `CORS_NOT_ALLOWED`, `FORBIDDEN`, `ADMIN_ONLY`, `SUPER_ADMIN_ONLY`, `OWN_ORDERS_ONLY` |
| 404 | `NOT_FOUND`, `USER_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `ORDER_NOT_FOUND` |
| 409 | `EMAIL_TAKEN`, `CONFLICT`, `SLUG_TAKEN`, `STOCK_CHANGED`, `REVIEW_TOO_SOON`, `NO_PRIOR_ORDER`, `ORDER_NOT_CANCELLABLE` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | `UNPROCESSABLE`, `EMPTY_CART`, `OUT_OF_STOCK`, `DELIVERY_AREA_NOT_SERVED` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL` (body stays generic in production; details logged) |
| 502/503/504 | `AI_UPSTREAM_ERROR`, `AI_NOT_CONFIGURED`, `AI_TIMEOUT`, `DB_NOT_READY` |

## Scripts

| Script | What |
| --- | --- |
| `npm run dev` | local server (tsx, same app as prod) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | compile to `dist/` |
| `npm run test:contract` | self-contained end-to-end contract suite (spawns the app on port 4100 with a throwaway DB) |
| `npm run db:init` | apply schema + seeds (idempotent) |
| `npm run db:backup` | dump tables to `data/backup-*.json` (dev) |
| `npm run make-defaults` | regenerate default product images |

## Verification

Run `npm run typecheck && npm run build && npm run test:contract` — the
contract suite boots the real app against a scratch database and walks the
whole public contract (123 checks): health/meta, auth incl. first-account
super-admin + token rotation/revocation, profile self-service, shop
(catalogue → categories → cart → checkout → admin status lifecycle →
owner-cancel with restock → double-cancel 409), delivery-area and empty-cart
guards, blood requests (guest + user lifecycle + admin moderation), support
inbox with replies, review moderation, live chat (visitor + admin side), AI
endpoints (503 when unconfigured + admin config surface), uploads, and every
admin panel route. CI-friendly: exit code 0 only when all checks pass.

