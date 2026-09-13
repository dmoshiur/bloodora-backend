/**
 * RBAC catalogue — the permissions this application actually enforces.
 *
 * Seeded into `permissions` / `roles` / `role_permissions` on first boot
 * (idempotent), editable at runtime through `/api/admin/permissions` and
 * `/api/admin/roles`. The seeded grants mirror exactly what the existing
 * `requireAdmin` / `requireSuperAdmin` middleware already allowed, so switching
 * routes to permission checks does not change behaviour for the frontend — it
 * makes the rule explicit, queryable and revocable.
 */

export interface PermissionDef {
  key: string;
  name: string;
  group: string;
  description: string;
}

export const PERMISSIONS: PermissionDef[] = [
  // ---- users ----
  { key: "users.view", name: "View users", group: "users", description: "List and inspect user accounts in the admin panel." },
  { key: "users.manage", name: "Edit users", group: "users", description: "Update another account's profile and flags." },
  { key: "users.delete", name: "Delete users", group: "users", description: "Permanently remove an account." },
  { key: "users.verify", name: "Verify donors", group: "users", description: "Approve a donor for the public directory." },
  { key: "users.role.assign", name: "Assign roles", group: "users", description: "Promote, demote and change an account's role." },
  { key: "users.create_admin", name: "Create admins", group: "users", description: "Provision a new admin account." },
  { key: "users.impersonate", name: "Impersonate users", group: "users", description: "Sign in as another account for support." },

  // ---- content & navigation ----
  { key: "content.view", name: "View content", group: "content", description: "Read Anti-D entries and educational resources." },
  { key: "content.manage", name: "Manage content", group: "content", description: "Create, edit and delete content entries." },
  { key: "navigation.view", name: "View navigation", group: "content", description: "Read the site navigation configuration." },
  { key: "navigation.manage", name: "Manage navigation", group: "content", description: "Create, edit, reorder and disable navigation entries." },
  { key: "notice.manage", name: "Manage site notice", group: "content", description: "Set or clear the site-wide notice bar." },

  // ---- shop ----
  { key: "shop.view", name: "View catalogue", group: "shop", description: "List products including unavailable ones." },
  { key: "shop.products.manage", name: "Manage products", group: "shop", description: "Create, edit, price and delete products." },

  // ---- orders & payments ----
  { key: "orders.view", name: "View orders", group: "orders", description: "List and open any order." },
  { key: "orders.manage", name: "Manage orders", group: "orders", description: "Change fulfilment status (cancel restocks items)." },
  { key: "payments.view", name: "View payments", group: "payments", description: "Read the transaction ledger." },
  { key: "payments.confirm", name: "Confirm payments", group: "payments", description: "Mark an order's payment as received." },
  { key: "payments.refund", name: "Refund payments", group: "payments", description: "Record a refund against a confirmed payment." },

  // ---- blood requests ----
  { key: "requests.view", name: "View blood requests", group: "requests", description: "Read every request, including contact details." },
  { key: "requests.moderate", name: "Moderate blood requests", group: "requests", description: "Change status or delete a request." },

  // ---- moderation & communication ----
  { key: "reviews.moderate", name: "Moderate reviews", group: "moderation", description: "Approve, reject, feature, reply to and delete reviews." },
  { key: "messages.view", name: "View support desk", group: "communication", description: "Read messages addressed to the admin desk." },
  { key: "messages.reply", name: "Reply to messages", group: "communication", description: "Answer user messages from the desk." },
  { key: "chat.view", name: "View live chat", group: "communication", description: "See every live conversation." },
  { key: "chat.reply", name: "Reply in live chat", group: "communication", description: "Answer visitors and close conversations." },

  // ---- AI ----
  { key: "ai.use", name: "Use the AI assistant", group: "ai", description: "Ask the Live AI Help (every signed-in visitor)." },
  { key: "ai.configure", name: "Configure AI", group: "ai", description: "Change provider, model, persona and API key." },

  // ---- settings & system ----
  { key: "settings.view", name: "View settings", group: "settings", description: "Read site settings (secrets masked)." },
  { key: "settings.manage", name: "Manage settings", group: "settings", description: "Change site identity, contacts and gateway numbers." },
  { key: "settings.branding", name: "Manage branding", group: "settings", description: "Upload the logo/favicon and set brand colours." },
  { key: "settings.smtp", name: "Manage mail server", group: "settings", description: "Configure SMTP and send test mail." },
  { key: "system.audit.view", name: "View audit log", group: "system", description: "Read the administrative audit trail." },
  { key: "system.backup", name: "Backups", group: "system", description: "Access backup information." },
  { key: "system.maintenance", name: "Run maintenance", group: "system", description: "Flush the mail outbox and prune expired data." },
];

export interface RoleDef {
  key: string;
  name: string;
  description: string;
  level: number;
  permissions: string[];
}

const ADMIN_PERMISSIONS = [
  "users.view",
  "users.verify",
  "content.view",
  "content.manage",
  "navigation.view",
  "navigation.manage",
  "notice.manage",
  "shop.view",
  "shop.products.manage",
  "orders.view",
  "orders.manage",
  "payments.view",
  "payments.confirm",
  "requests.view",
  "requests.moderate",
  "reviews.moderate",
  "messages.view",
  "messages.reply",
  "chat.view",
  "chat.reply",
  "ai.use",
  "ai.configure",
  "settings.view",
  "settings.manage",
  "settings.branding",
  "settings.smtp",
  "system.audit.view",
];

export const ROLES: RoleDef[] = [
  {
    key: "user",
    name: "User",
    description: "Registered donor / customer. Own data, orders, requests, reviews and messaging.",
    level: 1,
    permissions: ["ai.use"],
  },
  {
    key: "admin",
    name: "Admin",
    description: "Operates the site: content, shop, orders, payments, moderation and live support.",
    level: 5,
    permissions: ADMIN_PERMISSIONS,
  },
  {
    key: "super_admin",
    name: "Super Admin",
    description: "Full control, including account administration, roles, refunds and system tools.",
    level: 9,
    permissions: [...ADMIN_PERMISSIONS, "users.manage", "users.delete", "users.role.assign", "users.create_admin", "users.impersonate", "payments.refund", "system.backup", "system.maintenance"],
  },
];

/** Roles that may not be deleted or stripped (they back the auth model). */
export const SYSTEM_ROLE_KEYS = ROLES.map((r) => r.key);

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key);

export const PERMISSION_GROUPS = [...new Set(PERMISSIONS.map((p) => p.group))];

export function isKnownPermission(key: string): boolean {
  return PERMISSION_KEYS.includes(key);
}

export function isKnownRole(key: string): boolean {
  return SYSTEM_ROLE_KEYS.includes(key);
}
