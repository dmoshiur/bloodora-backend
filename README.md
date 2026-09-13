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
(`src/config/env.ts`).

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

| Method & path | Auth | Description |
| --- | --- | --- |
| `GET /api/health` | – | liveness + real `SELECT 1` DB round-trip |
| `GET /api/meta` | – | site settings, categories, divisions, payment methods |
| `POST /api/auth/register` | – | create account (first account = super admin) |
| `POST /api/auth/login` | – | login → `{user, token}` + session cookie |
| `POST /api/auth/logout` | cookie/bearer | rotate session token (revokes JWTs) |
| `GET /api/auth/me` | ✓ | current user |
| `PATCH /api/auth/profile` | ✓ | update name/email/phone/blood/city |
| `POST /api/auth/password` | ✓ | change password |
| `POST /api/auth/profile/image` | ✓ | multipart `image` → profile picture |
| `GET /api/donors` | – | verified donor directory |
| `GET /api/shop/products` | – | list (`?category=&search=&page=`) |
| `GET /api/shop/products/:id` | – | product by id or slug + approved reviews |
| `POST /api/shop/cart` | – | price a cart server-side (returns out-of-stock list) |
| `POST /api/shop/orders` | ✓ | place order (atomic stock deduction) |
| `GET /api/shop/orders/mine` | ✓ | my orders |
| `GET /api/shop/orders/:id` | owner | one order |
| `POST /api/shop/orders/:id/cancel` | owner | cancel while pending (restocks) |
| `POST /api/shop/reviews` | ✓ | review a purchased product (moderated) |
| `POST /api/shop/admin/products` | admin | create product (`image` optional) |
| `PUT /api/shop/admin/products/:id` | admin | update product |
| `DELETE /api/shop/admin/products/:id` | admin | delete product |
| `PATCH /api/shop/admin/products/:id/stock` | admin | `{delta}` stock adjust |
| `GET /api/shop/admin/orders` | admin | orders (`?status=`) |
| `GET /api/shop/admin/orders/:id` | admin | one order + items |
| `PATCH /api/shop/admin/orders/:id/status` | admin | advance status / confirm payment |
| `GET /api/blood-requests` | – | public board (`?status=&group=&page=`) |
| `POST /api/blood-requests` | – | post request (division/district/upazila or `location`) |
| `GET /api/blood-requests/mine` | ✓ | my requests |
| `PATCH /api/admin/blood-requests/:id/status` | admin | confirm/fulfil/cancel |
| `DELETE /api/admin/blood-requests/:id` | admin | delete |
| `POST /api/messages` | ✓ | user → support desk |
| `GET /api/messages/mine` | ✓ | my messages + unread |
| `POST /api/messages/read` | ✓ | mark read |
| `GET /api/admin/messages/inbox` | admin | desk inbox |
| `POST /api/admin/messages/:id/reply` | admin | reply to user |
| `GET /api/chat` | ✓ | my thread + chat key |
| `POST /api/chat/send` | ✓ | user message |
| `GET /api/chat/poll?since=` | ✓ | poll new entries |
| `GET /api/admin/chat` | admin | threads + unread |
| `GET /api/admin/chat/:userId` | admin | thread history |
| `POST /api/admin/chat/:userId/reply` | admin | reply |
| `POST /api/admin/chat/reply-by-message/:id` | admin | reply addressed by message id |
| `POST /api/ai/ask` | – | Live AI Help (`{question, history?}`) |
| `GET /api/ai/status` | – | availability flag (no secrets) |
| `GET /api/admin/ai/preview` | admin | current knowledge base |
| `POST /api/uploads` | ✓ | generic image upload (multipart `file`) |
| `GET /uploads/:file` · `GET /api/uploads/:file` | – | serve stored image |
| `GET /api/admin/dashboard` | admin | stats, recent orders/users, low stock |
| `GET /api/admin/activities` | admin | live activity feed |
| `GET /api/admin/content` | admin | content index for the CMS view |
| `GET /api/admin/users` | admin | list/search users |
| `PATCH /api/admin/users/:id/role` | admin | `user`/`admin`/`super_admin` |
| `PATCH /api/admin/users/:id/verified` | admin | donor verification |
| `DELETE /api/admin/users/:id` | admin | delete (guards: self, super-admin) |
| `POST /api/admin/impersonate` | admin | `{user_id}` → token bound to target |
| `POST /api/admin/switch-back` | admin | return to the original admin |
| `GET /api/admin/settings` | admin | settings (secrets masked) |
| `PUT /api/admin/settings` | admin | update (send `••••••••` to keep a secret) |
| `POST /api/admin/settings/logo` | admin | replace logo (multipart `logo`) |
| `GET /api/admin/reviews/pending` | admin | moderation queue |
| `POST /api/admin/reviews/:id/approve` | admin | approve/reject (`?approve=0`) |
| `DELETE /api/admin/reviews/:id` | admin | delete review |

### Error codes

| Status | Code (examples) |
| --- | --- |
| 400 | `VALIDATION_ERROR`, `BAD_JSON`, `BAD_BLOOD_GROUP`, `UPLOAD_ERROR` |
| 401 | `UNAUTHENTICATED`, `BAD_CREDENTIALS`, `SESSION_INVALID`, `LOGIN_REQUIRED` |
| 403 | `CORS_NOT_ALLOWED`, `FORBIDDEN`, `ADMIN_ONLY`, `SUPER_ADMIN_ONLY`, `OWN_ORDERS_ONLY` |
| 404 | `NOT_FOUND`, `USER_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `ORDER_NOT_FOUND` |
| 409 | `EMAIL_TAKEN`, `CONFLICT`, `SLUG_TAKEN`, `STOCK_CHANGED`, `REVIEW_TOO_SOON`, `NO_PRIOR_ORDER` |
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
| `npm run db:init` | apply schema + seeds (idempotent) |
| `npm run db:backup` | dump tables to `data/backup-*.json` (dev) |
| `npm run make-defaults` | regenerate default product images |

## Verification performed

- `tsc --noEmit` and `tsc` build: **0 errors**
- `typeof import("./dist/server.js").default === "function"`: **true** (valid
  Vercel Functions export, no `app.listen` in the module)
- End-to-end suite against a fresh database: health, bootstrap, register/
  login/logout, session persistence across restart, admin authorization,
  full shop flow (cart → order → stock 50→48 → status lifecycle), over-qty
  rejection with zero ghost orders, delivery-area + empty-cart 422s, blood
  request field mapping + fulfilment, review moderation, message inbox/reply,
  chat send/poll/admin reply, AI 503-when-unconfigured + preview, activity
  feed, upload byte-exact round-trip on both mounts, CORS allow + 403 deny,
  429 rate limiting — **all green**.
