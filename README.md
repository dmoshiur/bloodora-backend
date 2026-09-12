# 🩸 BloodOra — Backend API (standalone)

This folder is the **complete, separated backend** of BloodOra. It is a standalone
Node.js + Express + Turso REST API designed to be deployed on **its own Vercel
project (even a different Vercel account)**. The frontend (the root of this repo)
talks to this API over HTTPS. The two deployments are wired together **only via
environment variables**:

| Where | Variable | Meaning |
|---|---|---|
| **Backend** (this project) | `FRONTEND_URL` | The frontend's Vercel URL — CORS allow-list |
| **Frontend** (root of repo) | `BACKEND_URL` | This backend's Vercel URL |

---

## ✨ Features (complete)

- JWT authentication (register / login / logout / me) with single-session enforcement
- Donor directory + profiles (search by blood group / district / upazila)
- Blood requests (create as guest or user, urgent flag, fulfill, cancel, filters)
- Medical shop: products, cart pricing (server-side), checkout with bKash / Nagad /
  Upay / Rocket / Pathao / Card, Kalai-only delivery (৳10), stock decrement
- Orders: my orders, order detail, invoice data
- Messaging: user inbox/sent, send to admin or any user, replies, admin mailbox
- Full admin panel API: dashboard stats, site settings, site notice, donor
  verification, promote/demote/delete users, edit users, create admins,
  impersonation + switch-back, product CRUD with image upload, order management
  (confirm payment / update status), database backup info
- Image uploads (profile pictures, product photos) served at `/uploads/*`
- Public content: site settings, Anti-D info, resources, Bangladesh location data
- Socket.IO live-chat endpoint (same as the original monolith)
- Health check: `GET /api/health`

## 🚀 Deploy on Vercel (separate account)

1. Push this repo (or just sync the `backend/` folder) to the other Vercel account.
   - Easiest: create a new repo containing only the contents of `backend/`,
     or set the Vercel **Root Directory** to `backend` when importing this repo.
2. Vercel auto-detects Node.js (see `vercel.json`). Deploy.
3. In **Vercel → Project → Settings → Environment Variables**, set (as plain values):

   ```
   FRONTEND_URL=https://<your-frontend-project>.vercel.app
   JWT_SECRET=<long random string>
   TURSO_DATABASE_URL=libsql://<your-db>-<name>.turso.io
   TURSO_AUTH_TOKEN=<token>
   SUPER_ADMIN_NAME=Super Admin
   SUPER_ADMIN_EMAIL=you@example.com
   SUPER_ADMIN_PASSWORD=<strong password>
   SUPER_ADMIN_PHONE=+8801XXXXXXXXX
   ```

4. Redeploy. Check `https://<backend>.vercel.app/api/health` → should say `healthy`.

> Multiple frontend URLs (preview + production + custom domain)? Separate them with
> commas in `FRONTEND_URL`.

## 💻 Run locally

```bash
cd backend
npm install
cp .env.example .env     # fill Turso values or leave empty for local SQLite file
npm run dev              # http://localhost:4000
```

## 🔌 API overview

All endpoints are JSON. Authenticated endpoints expect
`Authorization: Bearer <token>` (token comes from `/api/auth/login` or `/api/auth/register`).

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | – | Health + DB check |
| GET | `/api/meta/home` | – | Homepage aggregate data |
| GET | `/api/meta/settings` | – | Site settings (public) |
| GET | `/api/meta/locations` | – | Divisions/districts/upazilas |
| GET | `/api/meta/antid` | – | Anti-D info list |
| GET | `/api/meta/resources` | – | Resources (filter `?category=`) |
| GET | `/api/meta/chat-auth` | opt | Chat widget identity |
| POST | `/api/auth/register` | – | Register (multipart, optional `profile_pic`) |
| POST | `/api/auth/login` | – | Login → `{ token, user }` |
| POST | `/api/auth/logout` | ✅ | Invalidate session token |
| GET | `/api/auth/me` | ✅ | Current user |
| GET | `/api/donors` | – | Verified donors (`?bg=&dist=&upa=&age_min=`) |
| GET | `/api/users/:id` | – | Public profile |
| PUT | `/api/users/me` | ✅ | Edit profile (multipart, optional `profile_pic`) |
| POST | `/api/users/me/toggle-status` | ✅ | Toggle donation availability |
| POST | `/api/users/me/apply-verification` | ✅ | Apply for donor verification |
| GET | `/api/blood-requests` | – | Open requests (`?bg=&division=&dist=&urgent=`) |
| GET | `/api/blood-requests/urgent` | – | Urgent open requests |
| POST | `/api/blood-requests` | opt | Create request |
| GET | `/api/blood-requests/:id` | – | Request detail |
| POST | `/api/blood-requests/:id/fulfill` | ✅ | Mark fulfilled |
| POST | `/api/blood-requests/:id/cancel` | ✅ | Cancel (owner/admin) |
| POST | `/api/blood-requests/urgent-contact` | opt | Urgent-page contact form |
| GET | `/api/shop/products` | – | Products (`?category=&search=`) |
| GET | `/api/shop/products/:id` | – | Product detail |
| GET | `/api/shop/categories` | – | Category list |
| POST | `/api/shop/cart/validate-item` | – | Stock/availability check |
| POST | `/api/shop/cart/resolve` | – | Price a cart `{ "1": 2 }` |
| GET | `/api/shop/checkout/context` | ✅ | Gateway numbers + saved payment info |
| POST | `/api/shop/orders` | ✅ | Place order (cart + payment + address) |
| GET | `/api/shop/orders/mine` | ✅ | My orders |
| GET | `/api/shop/orders/:id` | ✅ | Order detail (owner/admin) |
| GET | `/api/messages` | ✅ | Inbox (received/sent/unread) |
| POST | `/api/messages` | ✅ | Send message |
| GET | `/api/messages/:id` | ✅ | Read (marks read) |
| GET | `/api/messages/:id/original` | ✅ | Original for reply form |
| POST | `/api/messages/:id/reply` | ✅ | Reply |
| GET | `/api/messages/admin/list` | 👑 | Admin mailbox |
| POST | `/api/messages/admin/reply/:id` | 👑 | Admin reply |
| GET | `/api/admin/dashboard` | 👑 | Users + stats + notice + settings |
| GET/POST | `/api/admin/settings` | 👑 | Site settings |
| POST | `/api/admin/notice` | 👑 | Set site notice |
| GET | `/api/admin/notice/clear` | 👑 | Clear notice |
| POST | `/api/admin/verify-donor/:id` | 👑 | Verify donor |
| POST | `/api/admin/promote/:id` | 👑★ | Make admin |
| POST | `/api/admin/demote/:id` | 👑★ | Remove admin |
| DELETE | `/api/admin/user/:id` | 👑★ | Delete user |
| POST | `/api/admin/user/update/:id` | 👑★ | Edit user (+ reset password) |
| GET | `/api/admin/user/details/:id` | 👑★ | User details JSON |
| POST | `/api/admin/create-admin` | 👑★ | Create admin account |
| POST | `/api/admin/impersonate/:id` | 👑★ | Become user → new token |
| POST | `/api/admin/switch-back` | 👑★ | Revoke impersonation |
| GET | `/api/admin/products` | 👑 | All products |
| POST | `/api/admin/products` | 👑 | Add product (multipart `image`) |
| PUT | `/api/admin/products/:id` | 👑 | Edit product |
| DELETE | `/api/admin/products/:id` | 👑 | Delete product |
| GET | `/api/admin/orders` | 👑 | All orders (`?status=`) |
| GET | `/api/admin/orders/:id` | 👑 | Order detail + items |
| POST | `/api/admin/orders/:id/confirm-payment` | 👑 | Confirm payment |
| POST | `/api/admin/orders/:id/status` | 👑 | Update status |
| GET | `/api/admin/backup` | 👑★ | Backup guidance |

✅ = logged in · 👑 = admin · ★ = super admin

## ⚠️ Notes

- **Database**: always set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` in production.
  Without them the app falls back to an ephemeral `/tmp` SQLite on Vercel
  (data will not persist) — this is dev-only behaviour.
- **Uploads**: stored on the function filesystem (`/tmp/uploads` on Vercel). They
  survive while the function instance lives; for permanent storage consider object
  storage (e.g. Cloudflare R2) later — the API surface will not change.
- **Secrets**: `JWT_SECRET` must stay on the backend only. The frontend never sees it.
