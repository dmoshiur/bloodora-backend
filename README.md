# BloodOra Backend

Production backend for **BloodOra** — blood donation, blood requests, medical
supplies shop, orders and payments, notifications, in-app messaging, live chat,
Live AI Help and a permission-based admin panel. Localized en / bn / ar.

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

The first request runs an idempotent bootstrap: DDL + column migrations →
settings defaults → product/image seeds → clinical content seeds → **RBAC
catalogue** (roles, permissions, grants) → **navigation catalogue** →
super-admin provisioning (see `src/db/init.ts`). Every step is safe to re-run on
every cold start; a failure in the RBAC or navigation seed is logged and the app
continues (guards fall back to the legacy `is_admin` flags, `/api/meta/routes`
falls back to the built-in catalogue).

> The root-level `uploads/` folder is scratch space for `make-defaults` only —
> nothing on the request path reads it. It is ignored by git as **`/uploads/`**
> (anchored). An unanchored `uploads/` pattern also hides `src/uploads/`, which
> is real source (`src/uploads/uploads.ts`), so a fresh clone — i.e. every
> Vercel build — fails `tsc` with `TS2307 Cannot find module
> '../uploads/uploads.js'`.

## Deployment (Vercel serverless)

One function, one rewrite, no legacy routing:

```json
{
  "functions": { "api/index.ts": { "memory": 1024 } },
  "rewrites": [{ "source": "/(.*)", "destination": "/api" }]
}
```

`api/index.ts` default-exports a `function(req, res, next)` handler that
delegates to the Express app built by `src/app.ts` — the same app `npm run dev`
runs. There is **no `app.listen()`** anywhere on the request path; `src/dev.ts`
is the only place a server is owned.

Two rules this configuration exists to enforce:

- **Never mix the legacy `routes` array with `rewrites`.** They are two
  different routing systems; combining them is how a request ends up dispatched
  by one and path-rewritten by the other, which surfaces as
  `FUNCTION_INVOCATION_FAILED` or a 404 on paths that work locally.
- **Never declare a non-entrypoint in `functions`.** An earlier config listed
  `src/server.ts` as well as `api/index.ts`, which built a second function no
  route could reach and doubled the surface for
  `Invalid export found in module /var/task/server.js`.

The handler is wrapped so a synchronous `createApp()` failure (a malformed env
var, for instance) still exports a callable function that answers JSON 500 —
the module never fails to load, which is what turns a config mistake into a
public timeout instead of a readable error.

`npm run test:deploy` asserts every property above (config shape, entry
exports, "nothing but `dev.ts` listens", persistent session store, documented
env vars) so a regression fails in CI rather than on `vercel deploy`.

> `maxDuration` is deliberately not set. Values above 10 s are rejected on the
> Hobby plan and fail the deployment; raise it in the project settings (or here)
> only on a plan that allows it. Long-lived SSE endpoints
> (`/api/meta/activity/stream`, `/api/support/stream`,
> `/api/support/admin/stream`) poll the database rather than holding process
> state, so they degrade gracefully when an invocation is capped.

Required environment variables (all backend-only, never sent to the frontend):

| Var | Purpose |
| --- | --- |
| `TURSO_DATABASE_URL` | `libsql://…` remote database (required in prod) |
| `TURSO_AUTH_TOKEN` | Turso auth token (required in prod) |
| `JWT_SECRET` | signs session JWTs (required in prod) |
| `FRONTEND_URL` | comma-separated CORS allow-list (required in prod); the **first** origin is also the base for links in outgoing mail |
| `COOKIE_DOMAIN` | optional shared cookie domain |
| `SUPER_ADMIN_EMAIL/PASSWORD/NAME/PHONE` | idempotent super-admin bootstrap |
| `MAX_UPLOAD_MB` | optional per-image upload cap (default `4`; Vercel rejects request bodies over 4.5 MB) |
| `GROQ_API_KEY`, `AI_*` | Live AI Help (admin panel can override) |
| `SMTP_*` | transactional mail defaults — the Admin → SMTP panel overrides them once saved |

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
- **Authorization (RBAC)** — every privileged route declares the *permission* it
  needs (`requirePermission("payments.refund")`) instead of a single
  `is_admin` bit. The caller's role is re-read from the database on every
  request and its permission set resolved from `role_permissions`, so a JWT
  claim is never sufficient and a revoked privilege stops working on the next
  request rather than the next login. Three roles are seeded (`user`, `admin`,
  `super_admin`) with exactly the abilities the old `requireAdmin` /
  `requireSuperAdmin` middleware granted, so existing admins notice no change;
  custom roles can be created in the panel. Guards against lockout: an admin
  cannot strip permissions from the role they are currently using
  (`SELF_LOCKOUT`), cannot downgrade their own account (`SELF_DEMOTE`), a role
  still assigned to accounts cannot be deleted (`ROLE_IN_USE`), and built-in
  roles are immutable (`SYSTEM_ROLE`). Super admins remain protected from
  demotion/deletion by non-super-admins.
- **Audit trail** — privileged actions (role and permission changes, payment
  confirmations and refunds, order status changes, content CRUD, settings and
  SMTP changes, impersonation, logins, failed logins **and permission denials**)
  are written to `audit_logs` with actor, role, entity, IP and user agent, and
  are readable at `GET /api/admin/audit`. Metadata passes through the logger's
  redactor on the way in, so an audit row can never become a credential store.
- **Password reset & email verification** — single-use tokens
  (`auth_tokens`): 256-bit random, stored **only as a SHA-256 hash**, 30 min /
  48 h expiry, consumption is a conditional `UPDATE` so two concurrent
  submissions of the same link cannot both succeed, and issuing a new token
  revokes the previous one. Completing a reset rotates `users.session_token`,
  which invalidates every JWT already issued for that account.
  `POST /api/auth/forgot-password` returns the **same response whether or not
  the address exists** — it is not an account-enumeration oracle — and is
  throttled per account and per IP.
- **Rate limiting** — two layers: an in-process fixed window plus, for sensitive
  scopes (`login`, `register`, `password-reset`, `verify-*`, `order-place`, AI
  and chat sends), a database-backed window that survives cold starts and is
  shared across instances. Sensitive scopes are bucketed by IP **and** by the
  submitted account, so rotating IPs does not reset the counter and one account
  cannot lock out a shared NAT. Exceeding a limit returns `429` with
  `Retry-After`; a successful login clears its own bucket. The shared layer
  fails **open** on a database error so a Turso blip cannot lock everybody out.
- **CORS** — only origins listed in `FRONTEND_URL` are accepted; others get
  `403 CORS_NOT_ALLOWED` (handled centrally, not a 500).
- **Secrets** — SMTP password and AI API key are stored only in the DB
  `settings` table; the admin panel receives masked values (`••••••••`) and
  sends that marker back to keep them unchanged.
- **Orders & pricing** — the server is the only authority on price: the client
  sends `{productId: qty}` and nothing else that affects money, and any
  client-supplied `price`/`total`/`subtotal`/`delivery_fee` is ignored. Order +
  line items + stock decrement run in a **single transaction**
  (`orderRepo.placeTx`), and stock is re-checked *inside* it, so two concurrent
  checkouts for the last unit cannot both succeed — the loser rolls back with
  `400 OUT_OF_STOCK` (including the real remaining quantity) instead of creating
  a ghost order or negative stock. Cancellation restocks **exactly once**: the
  status flip is the claim (`WHERE status = 'pending'` for owners, a
  transition-guarded transaction for admins), so a double-cancel or a cancel
  racing an admin cannot inflate stock. The delivery fee and served areas come
  from `settings` (`delivery_fee`, `delivery_areas`,
  `free_shipping_threshold`) — editable in Admin → Site Settings, defaulting to
  the original Kalai-only ৳10 rule.
- **Payments** — every order gets a `transactions` ledger row
  (`pending → successful | failed | cancelled`, refunds as separate
  `kind = 'refund'` rows). Confirmation and refund are conditional updates
  inside one transaction, so a double-click on "Confirm payment" cannot record
  two successful charges and a refund can only be issued once against a
  successful charge. A cancelled order's closed charge is never resurrected, and
  payment cannot be confirmed on a cancelled order (`409 ORDER_CANCELLED`).
- **Mail** — outgoing mail is written to a durable `email_outbox` **before** any
  SMTP attempt and retried up to 5 times, so a mail host that is down or slow
  delays a confirmation instead of failing the order, reset or reply that
  triggered it. `GET /api/admin/mail/outbox` shows the queue;
  `POST /api/admin/mail/flush` retries it. Every message is localized into the
  recipient's saved language (en / bn / ar, RTL-aware HTML, no external assets).
- **AI output** — reasoning models (`qwen3`, `gpt-oss`, `kimi-k2-thinking`, …)
  can emit their chain of thought inline in `message.content`. Every answer is
  sanitized before it is stored or shown (`src/services/aiSanitize.ts`): paired,
  unterminated and stray `<think>`-style blocks are removed, provider
  `reasoning*` fields are never read, and streaming goes through a tail-buffered
  filter so a tag split across two SSE frames is still caught. An answer that
  was *only* reasoning surfaces as `502 AI_EMPTY_RESPONSE` rather than a blank
  bubble. Upstream `5xx`/`429`/network failures are retried once.
- **Idempotency** — live-chat sends accept a `client_message_id`
  (aliases: `clientMessageId`, `client_id`, `idempotency_key`, `message_id`),
  unique per session, so a retry, reconnect replay or double-click returns the
  stored message with `duplicate: true` instead of posting it twice.
- **Uploads** — `src/uploads/uploads.ts` parses multipart bodies with multer's
  **memory** storage (a serverless filesystem is read-only and ephemeral):
  images only, a per-file size cap, random storage names (the client's file name
  is never used in a path or URL), and every `MulterError` mapped to the
  documented `400 UPLOAD_ERROR` instead of a `500`. Bytes are persisted into the
  `uploads` table by `uploadService` and streamed back by `GET /uploads/:file`;
  SVGs are served with `Content-Security-Policy: sandbox` so an embedded script
  gets an opaque origin instead of the API's.
- **Timestamps** — two formats live in this database: SQLite's
  `datetime('now')` (`2026-09-13 06:49:18`, what every `created_at` default
  writes and what the frontend templates slice) and JavaScript's
  `toISOString()`. Comparing them as **strings** is always false (`' '` sorts
  before `'T'`), which silently killed both realtime channels. Everything that
  compares time now goes through `src/utils/time.ts` (`toEpochMs`, `isAfter`),
  and rows the app writes itself are explicit ISO-8601.
- **Logging** — structured JSON, redacts `*secret/token/password/key/cookie*`
  fields, never logs request bodies; 5xx logs include stack + path.

## Feature architecture

### Internationalization (en / bn / ar)

`src/i18n/index.ts` is a flat catalogue (89 keys) with `{placeholder}`
interpolation and per-language direction metadata. `languageMiddleware` resolves
one language per request, in this order:

1. an explicit `?lang=bn` or a `lang` field in the body — the frontend's language
   switcher drives backend text without a redeploy;
2. the signed-in user's saved preference (`users.language`), applied by the auth
   middleware once the caller is known;
3. `Accept-Language` (q-values honoured);
4. the admin-configured site default (`settings.default_language`, cached 30 s);
5. `en`.

Handlers get `req.lang`, `req.langDir` and `req.t(key, params)`; services take an
optional `lang` argument and use `translate()` so background work (emails,
notifications) renders in the **recipient's** language rather than the triggering
request's. Localized today: auth and password-reset messages, checkout and stock
rejections, order lifecycle, live chat (greeting, closed-conversation, empty and
too-long messages), rate-limit responses, notifications and every email template
(RTL-aware HTML).

### Notifications

`notifications` rows are addressed either to a user id or to the shared admin
desk sentinel (`admins`), so one event can fan out to a buyer *and* the panel
without duplicating templates. Writes are deduplicated by
`UNIQUE(user_id, dedupe_key)` with `ON CONFLICT DO NOTHING` — the same order
cannot notify the same person twice no matter how many code paths emit it.
Emission is fire-and-forget (`emitAsync`) and never fails the operation that
caused it. Recipients' `notify_inapp` preference is enforced inside the service,
so every feature honours it without remembering to.

### Permissions

`src/data/permissions.ts` is the catalogue (35 keys in 11 groups). The seeded
grants reproduce exactly what `requireAdmin` / `requireSuperAdmin` allowed, so
the switch to permission checks changed no behaviour for existing accounts — it
made the rule explicit, queryable and revocable. `rbacService.seed()` reconciles
on every boot using `roles.seeded_permissions`: a permission **new in this
deploy** is granted (roles keep working when a feature is added), while a
permission an admin **deliberately revoked** stays revoked. Without that record
the two cases are indistinguishable, and "backfill everything the catalogue
lists" would silently undo an admin's decision on every deploy.

### Navigation

`GET /api/meta/routes` has always returned the site's page catalogue — the
frontend uses it for navigation/SEO and the AI assistant uses it to turn a
mentioned page into a real link. It now comes from the `navigation` table
(seeded once from the same built-in array), so hiding, renaming, adding or
reordering a page is a panel action instead of a deploy. The public response
shape is unchanged; `GET /api/meta/nav` adds the menu-oriented view
(`public` / `user` / `admin`, already filtered by who is asking).

### Mail

`email_outbox` is a durable queue: enqueue → attempt → `sent` / `failed`
(retried up to 5 times). SMTP settings come from the database when an admin has
saved them and from `SMTP_*` env vars otherwise — seeded defaults deliberately do
**not** exist for these keys, because a stored `smtp_enabled = "0"` silently
overrides the operator's environment and makes "why is no mail going out?"
undiagnosable from the panel. On a serverless deployment nothing runs on a
timer, so `POST /api/admin/maintenance` (or an external cron hitting it) performs
the sweep: flush mail, purge expired tokens and stale rate-limit buckets, prune
bounded history tables.

### Data model

28 tables. Added for the above: `roles`, `permissions`, `role_permissions`,
`notifications`, `transactions`, `audit_logs`, `auth_tokens`, `rate_limits`,
`email_outbox`, `navigation` — plus v3 columns on `users` (`language`,
`email_verified`, `last_login_at`, `notify_email`, `notify_inapp`),
`live_messages.client_message_id` and `ai_messages.tokens` /
`ai_messages.reasoning_chars`. Column migrations are additive and idempotent
(`src/db/schema.ts` → `MIGRATIONS`), so an existing database is upgraded in place
on the first request after a deploy.

## API overview

Base: `/api` — errors always return `{ error: { code, message, details? } }`.
This table is generated from `src/routes/*` — it is the contract the BloodOra
frontend (dmoshiur/lspk) calls, verified end-to-end by `npm run test:contract`.

### Public

| Method & path | Description |
| --- | --- |
| `GET /api/health` | liveness + real `SELECT 1` DB round-trip |
| `GET /api/meta` | site settings, categories, divisions, payment methods, delivery |
| `GET /api/meta/settings` · `/home` · `/locations` · `/routes` | page-level meta views (`/routes` is served from the `navigation` table) |
| `GET /api/meta/nav` | menu areas (`public` always; `user`/`admin` when signed in) |
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
| `POST /api/support/messages` | `{session_key, body, client_message_id?}` visitor message (idempotent per key) |
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
| `GET /api/auth/me` | current user **+ `account_role` and `permissions`** |
| `POST /api/auth/forgot-password` | `{email}` → mails a single-use reset link (same response whether or not the account exists) |
| `GET /api/auth/reset-password/validate?token=` | is this reset link still usable? |
| `POST /api/auth/reset-password` | `{token, password}` → new password, all sessions revoked |
| `POST /api/auth/verify-email/request` · `POST`/`GET /api/auth/verify-email` | send / confirm the email-verification link |
| `GET /api/rbac/me` | the caller's effective role + permissions |
| `GET /api/user/dashboard` | personal aggregate: identity, donation status, counts, unread badges, spend, recent items |
| `PATCH /api/users/me/preferences` | `{language?, notify_email?, notify_inapp?}` |
| `GET /api/notifications` · `/unread` | in-app feed (+ admin desk for admins) and badge counts |
| `POST /api/notifications/:id/read` · `/read-all` · `DELETE /:id` | manage the feed |
| `GET /api/payments/me` · `/api/payments/order/:id` | my ledger / one order's ledger |
| `PATCH /api/auth/profile` | update name/email/phone/blood/city |
| `POST /api/auth/password` | `{current, next}` change password |
| `POST /api/auth/profile/image` | multipart `image` → profile picture |
| `PUT /api/users/me` | self-service profile edit (multipart, optional `profile_pic`) |
| `POST /api/users/me/toggle-status` | donation availability toggle |
| `POST /api/users/me/apply-verification` | 18+ gate, admin reviews afterwards |
| `GET /api/shop/checkout/context` | gateway numbers + saved wallet/address |
| `POST /api/shop/orders` | checkout — `{cart, payment_method, division, district, upazila, …}`; server-side pricing, atomic stock deduction, returns `{orderId, total, payment}` |
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
| `POST /api/admin/orders/:id/confirm-payment` | confirm payment (idempotent; writes the ledger, audit row, notification and receipt email) |
| `GET /api/admin/payments` · `/payments/summary` · `/payments/order/:id` | transaction ledger, totals, one order |
| `POST /api/admin/payments/order/:id/refund` | record a refund (`payments.refund` — super admin) |
| `GET/POST /api/admin/roles` · `GET/PUT/DELETE /api/admin/roles/:key` | role management |
| `GET /api/admin/permissions` | permission catalogue (grouped, with the roles holding each key) |
| `POST /api/admin/users/:id/role` | assign a role (`users.role.assign`) |
| `GET /api/admin/audit` | audit trail (`?action=&actor_id=&entity_type=&entity_id=&limit=&offset=`) |
| `GET /api/admin/navigation` · `POST` · `PUT/DELETE /:id` · `POST /:id/toggle` · `/reorder` · `/seed` | site navigation manager |
| `GET /api/admin/mail/outbox` · `POST /api/admin/mail/flush` | mail queue + retry |
| `POST /api/admin/maintenance` | one idempotent sweep: mail queue, expired tokens, stale rate-limit buckets, bounded history tables |
| `GET /api/admin/blood-requests/:id` · `PATCH /:id/status` · `DELETE /:id` | moderate requests |
| `POST /api/admin/verify-donor/:id` | donor verification |
| `POST /api/admin/promote/:id` · `/demote/:id` | legacy admin flag toggle (`users.role.assign`) |
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
| 400 | `VALIDATION_ERROR`, `BAD_JSON`, `BAD_BLOOD_GROUP`, `UPLOAD_ERROR`, `PROTECTED_USER`, `EMPTY_CART`, `OUT_OF_STOCK`, `DELIVERY_AREA_NOT_SERVED`, `PASSWORD_SHORT`, `RESET_TOKEN_INVALID`, `VERIFY_TOKEN_INVALID`, `BAD_LANGUAGE`, `NO_CHANGES`, `SELF_LOCKOUT`, `SELF_DEMOTE`, `SYSTEM_ROLE`, `REFUND_TOO_LARGE` |
| 401 | `UNAUTHENTICATED`, `BAD_CREDENTIALS`, `SESSION_INVALID`, `LOGIN_REQUIRED` |
| 403 | `CORS_NOT_ALLOWED`, `FORBIDDEN`, `PERMISSION_DENIED`, `ADMIN_ONLY`, `SUPER_ADMIN_ONLY`, `OWN_ORDERS_ONLY` |
| 404 | `NOT_FOUND`, `USER_NOT_FOUND`, `PRODUCT_NOT_FOUND`, `ORDER_NOT_FOUND`, `ROLE_NOT_FOUND`, `NOTIFICATION_NOT_FOUND` |
| 409 | `EMAIL_TAKEN`, `CONFLICT`, `SLUG_TAKEN`, `STOCK_CHANGED`, `REVIEW_TOO_SOON`, `NO_PRIOR_ORDER`, `ORDER_NOT_CANCELLABLE`, `ORDER_CANCELLED`, `ALREADY_REFUNDED`, `NO_SUCCESSFUL_CHARGE`, `ROLE_EXISTS`, `ROLE_KEY_RESERVED`, `ROLE_IN_USE`, `NAVIGATION_PATH_TAKEN` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 422 | `UNPROCESSABLE` |
| 429 | `RATE_LIMITED`, `RESET_THROTTLED` (with `Retry-After`) |
| 500 | `INTERNAL` (body stays generic in production; details logged) |
| 502/503/504 | `AI_UPSTREAM_ERROR`, `AI_NOT_CONFIGURED`, `AI_TIMEOUT`, `AI_EMPTY_RESPONSE`, `DB_NOT_READY` |

Checkout rejections use **400 with a distinct `code`** on purpose: the frontend
renders a 400 as a "warning" flash the shopper can act on (change the quantity,
pick another area) and any other 4xx as a "danger" flash. Codes are stable, so a
client can branch without parsing a localized message. `details` carries the
machine-readable part (e.g. `{product_id, requested, available}`).

## Scripts

| Script | What |
| --- | --- |
| `npm run dev` | local server (tsx, same app as prod) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | compile to `dist/` |
| `npm run test` | every suite below, in order (deploy → AI → contract → v3) |
| `npm run test:contract` | end-to-end **contract** suite — the endpoints the shipped frontend calls (spawns the app on port 4100 with a throwaway DB) |
| `npm run test:v3` | end-to-end **v3 feature** suite — reset/verify flows, dashboard, notifications, ledger, strict pricing, RBAC, navigation, chat idempotency, rate limits (port 4200) |
| `npm run test:ai` | unit tests for AI output sanitization (incl. streamed reasoning tags split across chunks) |
| `npm run test:deploy` | deployment guard: `vercel.json` shape, entry exports, "only `dev.ts` listens", session store, documented env vars |
| `npm run db:init` | apply schema + seeds (idempotent) |
| `npm run db:backup` | dump tables to `data/backup-*.json` (dev) |
| `npm run make-defaults` | regenerate default product images |

## Verification

```bash
npm run typecheck && npm run build && npm test     # 357 checks, exit 0 only when all pass
```

| Suite | Checks | What it covers |
| --- | --- | --- |
| `test:deploy` | 32 | `vercel.json` shape (no legacy `routes`, one rewrite, no non-entrypoint functions), default-exported handler, nothing but `dev.ts` listens, Turso session store, documented env vars |
| `test:ai` | 31 | reasoning-block removal (paired / unterminated / stray / case-insensitive / every tag name), provider `reasoning*` fields never read, streamed tags split across chunks, clean text untouched |
| `test:contract` | 125 | the contract the shipped frontend calls: health/meta, auth incl. first-account super-admin + token rotation/revocation, profile self-service, shop (catalogue → cart → checkout → admin lifecycle → owner-cancel with restock → double-cancel 409), blood requests, support inbox, review moderation, live chat, AI (503 when unconfigured), uploads, every admin route |
| `test:v3` | 169 | everything added on top: health envelope, backend i18n (`?lang=`, `Accept-Language`, saved preference), forgot/reset password and email verification **driven end-to-end by reading the link out of the mail outbox**, personal dashboard, notifications (feed, badges, read/read-all/delete, per-account isolation, channel opt-out), payment ledger (idempotent confirm, single refund, cancelled-order guards), server-authoritative pricing (client prices ignored, stock enforced, delivery fee from settings, restock exactly once), RBAC (seeded roles, custom role, denials, self-lockout/self-demote guards, audit trail), navigation CRUD/ordering/visibility, chat idempotency, shared rate limiting with `Retry-After`, activity SSE cursor |

Both end-to-end suites spawn the real app on a scratch port against a throwaway
local libSQL database, and **fail loudly if that port is already serving** — a
detached child from an earlier crashed run would otherwise answer requests with
stale code and stale data. The v3 suite enables SMTP against an unresolvable
host on purpose: mail is queued and then fails, which is exactly the "mail host
down" case the outbox exists for, and it lets the suite read the reset and
verification links a real deployment would email.

