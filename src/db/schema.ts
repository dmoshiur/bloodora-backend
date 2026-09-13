import { all, run } from "./query.js";

/** Full schema as ordered DDL statements. Every statement is idempotent. */
const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_super_admin INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'user',
    donation_role TEXT NOT NULL DEFAULT 'Both',
    blood_group TEXT,
    city TEXT,
    address_holding TEXT,
    division TEXT,
    district TEXT,
    upazila TEXT,
    union_area TEXT,
    can_donate INTEGER NOT NULL DEFAULT 0,
    last_donation TEXT,
    age INTEGER,
    date_of_birth TEXT,
    birth_certificate_number TEXT,
    bkash_number TEXT,
    nagad_number TEXT,
    upay_number TEXT,
    rocket_number TEXT,
    pathao_number TEXT,
    card_last_four TEXT,
    card_type TEXT,
    is_verified INTEGER NOT NULL DEFAULT 0,
    image_file TEXT,
    session_token TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`,
  `CREATE INDEX IF NOT EXISTS idx_users_verified ON users(is_verified)`,
  `CREATE INDEX IF NOT EXISTS idx_users_blood ON users(blood_group)`,
  `CREATE INDEX IF NOT EXISTS idx_users_district ON users(district)`,

  `CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0,
    category TEXT,
    description TEXT,
    image_file TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    sales_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)`,
  `CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug)`,

  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_phone TEXT NOT NULL,
    address TEXT NOT NULL,
    city TEXT NOT NULL,
    division TEXT,
    district TEXT,
    upazila TEXT,
    payment_method TEXT NOT NULL,
    payment_ref TEXT,
    subtotal REAL NOT NULL,
    delivery_fee REAL NOT NULL DEFAULT 0,
    total REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    payment_status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)`,

  `CREATE TABLE IF NOT EXISTS order_items (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    product_image TEXT,
    price REAL NOT NULL,
    qty INTEGER NOT NULL,
    line_total REAL NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)`,

  `CREATE TABLE IF NOT EXISTS blood_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    hospital TEXT,
    patient_name TEXT,
    patient_relation TEXT,
    hospital_name TEXT,
    hospital_address TEXT,
    contact_person TEXT,
    contact_phone TEXT,
    contact_email TEXT,
    urgent_reason TEXT,
    needed_by TEXT,
    additional_info TEXT,
    blood_group TEXT NOT NULL,
    units INTEGER NOT NULL DEFAULT 1,
    quantity TEXT,
    division TEXT,
    district TEXT,
    upazila TEXT,
    location_division TEXT,
    location_district TEXT,
    location_upazila TEXT,
    urgent INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    is_fulfilled INTEGER NOT NULL DEFAULT 0,
    fulfilled_at TEXT,
    fulfilled_by TEXT,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blood_status ON blood_requests(status)`,
  `CREATE INDEX IF NOT EXISTS idx_blood_group ON blood_requests(blood_group)`,

  `CREATE TABLE IF NOT EXISTS activities (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    user_id TEXT,
    message TEXT NOT NULL,
    meta TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_activities_created ON activities(created_at)`,

  // User↔admin messaging (subject + reply threading; recipient_id 'admin'
  // means the site administrator).
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    is_admin_message INTEGER NOT NULL DEFAULT 0,
    is_admin_reply INTEGER NOT NULL DEFAULT 0,
    replied_to TEXT,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id)`,

  // Live Messaging (support chat): sessions are keyed by an opaque
  // session_key (guests included), messages are appended per session.
  `CREATE TABLE IF NOT EXISTS live_sessions (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL UNIQUE,
    user_id TEXT,
    visitor_name TEXT NOT NULL DEFAULT 'Guest',
    last_message TEXT,
    last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
    unread_admin INTEGER NOT NULL DEFAULT 0,
    unread_visitor INTEGER NOT NULL DEFAULT 0,
    is_open INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_live_sessions_open ON live_sessions(is_open)`,

  `CREATE TABLE IF NOT EXISTS live_messages (
    id TEXT PRIMARY KEY,
    session_key TEXT NOT NULL,
    sender_type TEXT NOT NULL DEFAULT 'visitor',
    sender_name TEXT,
    body TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_live_messages_key ON live_messages(session_key)`,

  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL UNIQUE,
    original_name TEXT,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,

  // kind: 'product' (product_id set) or 'site' (general testimonial).
  // status: pending → approved | rejected (admin moderation queue).
  `CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    product_id TEXT,
    user_id TEXT NOT NULL,
    author_name TEXT,
    kind TEXT NOT NULL DEFAULT 'product',
    rating INTEGER NOT NULL DEFAULT 5,
    title TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    is_approved INTEGER NOT NULL DEFAULT 0,
    is_featured INTEGER NOT NULL DEFAULT 0,
    admin_reply TEXT,
    admin_replied_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_reviews_approved ON reviews(is_approved)`,

  // Anti-D medication entries (Admin → Content manager; seeds from content.ts).
  `CREATE TABLE IF NOT EXISTS anti_d_info (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    timing TEXT NOT NULL,
    dosage TEXT NOT NULL,
    image_file TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // Educational resources (Admin → Content manager; seeds from content.ts).
  `CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT,
    content TEXT NOT NULL,
    summary TEXT,
    image_file TEXT,
    is_featured INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_resources_category ON resources(category)`,

  // Single active site notice (shown in the site header).
  `CREATE TABLE IF NOT EXISTS site_notice (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // Outgoing email log (Admin → SMTP & Email).
  `CREATE TABLE IF NOT EXISTS email_log (
    id TEXT PRIMARY KEY,
    to_email TEXT,
    subject TEXT,
    status TEXT NOT NULL DEFAULT 'sent',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // Live AI Help conversation history (per conversation_id).
  `CREATE TABLE IF NOT EXISTS ai_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    user_id TEXT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ai_messages_conv ON ai_messages(conversation_id)`,
];

const SETTINGS_DEFAULTS: Record<string, string> = {
  // --- identity / branding (original site_settings fields) ---
  site_name: "BloodOra",
  site_tagline: "Donate blood. Save lives.",
  site_description: "Connecting blood donors to save lives across Bangladesh.",
  site_email: "info.bloodora@gmail.com",
  site_phone: "+8801709202140",
  site_address: "Kalai, Rajshahi, Bangladesh",
  facebook_url: "https://www.facebook.com/profile.php?id=61575592734038",
  twitter_url: "#",
  instagram_url: "#",
  linkedin_url: "#",
  logo_file: "",
  favicon_file: "",
  brand_primary: "#e31b23",
  brand_accent: "#ff3340",
  brand_font_style: "calligraphic",
  default_language: "en",
  footer_note: "BloodOra — donate blood, save lives.",
  primary_color: "#c62828",
  font_style: "default",
  announcement: "",
  whatsapp: "",
  support_phone: "+8801709202140",
  email: "info.bloodora@gmail.com",
  address: "Kalai, Rajshahi, Bangladesh",
  language: "en",
  // --- payment gateways (merchant numbers shown at checkout) ---
  bkash_merchant_number: "01709202140",
  nagad_merchant_number: "01800000000",
  upay_merchant_number: "01600000000",
  rocket_merchant_number: "01900000000",
  pathao_merchant_number: "01500000000",
  bKash_number: "",
  bKash_merchant: "",
  Nagad_number: "",
  Nagad_merchant: "",
  Rocket_number: "",
  Rocket_merchant: "",
  card_enabled: "0",
  // --- delivery (Kalai-only, ৳10 flat) ---
  delivery_areas: "Kalai",
  delivery_fee: "10",
  free_shipping_threshold: "0",
  // --- SMTP ---
  smtp_enabled: "0",
  smtp_host: "",
  smtp_port: "587",
  smtp_secure: "0",
  smtp_user: "",
  smtp_pass: "",
  smtp_from_name: "BloodOra",
  smtp_from_email: "no-reply@bloodora.site",
  // --- Live AI Help ---
  ai_enabled: "1",
  ai_provider: "groq",
  ai_model: "qwen/qwen3.6-27b",
  ai_base_url: "https://api.groq.com/openai/v1",
  ai_api_key: "",
  ai_temperature: "0.5",
  ai_max_tokens: "900",
  ai_persona: "",
  ai_prompts: "",
  // --- live features toggles ---
  live_chat_enabled: "1",
  live_activity_enabled: "1",
};

export async function ensureColumn(table: string, column: string, definition: string): Promise<void> {
  const rows = await all<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!rows.some((r) => r.name === column)) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** Columns added after v1 tables existed — backfilled idempotently. */
const MIGRATIONS: Array<[string, string, string]> = [
  // users (v2: donor profile + wallet + admin levels)
  ["users", "is_super_admin", "INTEGER NOT NULL DEFAULT 0"],
  ["users", "donation_role", "TEXT NOT NULL DEFAULT 'Both'"],
  ["users", "address_holding", "TEXT"],
  ["users", "division", "TEXT"],
  ["users", "district", "TEXT"],
  ["users", "upazila", "TEXT"],
  ["users", "union_area", "TEXT"],
  ["users", "can_donate", "INTEGER NOT NULL DEFAULT 0"],
  ["users", "last_donation", "TEXT"],
  ["users", "age", "INTEGER"],
  ["users", "date_of_birth", "TEXT"],
  ["users", "birth_certificate_number", "TEXT"],
  ["users", "bkash_number", "TEXT"],
  ["users", "nagad_number", "TEXT"],
  ["users", "upay_number", "TEXT"],
  ["users", "rocket_number", "TEXT"],
  ["users", "pathao_number", "TEXT"],
  ["users", "card_last_four", "TEXT"],
  ["users", "card_type", "TEXT"],
  // orders
  ["orders", "payment_ref", "TEXT"],
  ["orders", "upazila", "TEXT"],
  // messages (v2: subject + threading)
  ["messages", "subject", "TEXT NOT NULL DEFAULT ''"],
  ["messages", "is_admin_message", "INTEGER NOT NULL DEFAULT 0"],
  ["messages", "replied_to", "TEXT"],
  // blood_requests (v2: original request form fields)
  ["blood_requests", "patient_name", "TEXT"],
  ["blood_requests", "patient_relation", "TEXT"],
  ["blood_requests", "hospital_name", "TEXT"],
  ["blood_requests", "hospital_address", "TEXT"],
  ["blood_requests", "contact_person", "TEXT"],
  ["blood_requests", "contact_phone", "TEXT"],
  ["blood_requests", "contact_email", "TEXT"],
  ["blood_requests", "urgent_reason", "TEXT"],
  ["blood_requests", "needed_by", "TEXT"],
  ["blood_requests", "additional_info", "TEXT"],
  ["blood_requests", "quantity", "TEXT"],
  ["blood_requests", "location_division", "TEXT"],
  ["blood_requests", "location_district", "TEXT"],
  ["blood_requests", "location_upazila", "TEXT"],
  ["blood_requests", "is_fulfilled", "INTEGER NOT NULL DEFAULT 0"],
  ["blood_requests", "fulfilled_at", "TEXT"],
  ["blood_requests", "fulfilled_by", "TEXT"],
  ["blood_requests", "updated_at", "TEXT"],
  // reviews (v2: three-state moderation + author name)
  ["reviews", "status", "TEXT NOT NULL DEFAULT 'pending'"],
  ["reviews", "author_name", "TEXT"],
  // resources (v2: read_time from the original content manager)
  ["resources", "read_time", "TEXT"],
];

/** Apply all DDL + migrations + settings defaults. Idempotent — safe on boot. */
export async function applySchema(): Promise<void> {
  for (const stmt of DDL) {
    await run(stmt);
  }
  for (const [table, column, definition] of MIGRATIONS) {
    await ensureColumn(table, column, definition);
  }
  for (const [key, value] of Object.entries(SETTINGS_DEFAULTS)) {
    await run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO NOTHING`,
      [key, value],
    );
  }
}

export const TABLES = [
  "users",
  "products",
  "orders",
  "order_items",
  "blood_requests",
  "activities",
  "messages",
  "live_sessions",
  "live_messages",
  "settings",
  "uploads",
  "sessions",
  "reviews",
  "anti_d_info",
  "resources",
  "site_notice",
  "email_log",
  "ai_messages",
];
