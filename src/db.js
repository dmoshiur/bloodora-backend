// ==================== BloodOra Backend - Turso / libSQL Database Layer ====================
// Supports both Turso serverless (libsql://) and local file fallback for dev.
import { createClient } from "@libsql/client";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TURSO_URL = (process.env.TURSO_DATABASE_URL || "").trim();
const TURSO_TOKEN = (process.env.TURSO_AUTH_TOKEN || "").trim();

let clientConfig;
if (TURSO_URL.startsWith("libsql://") || TURSO_URL.startsWith("https://")) {
  clientConfig = { url: TURSO_URL, authToken: TURSO_TOKEN };
  console.log("☁️  Using Turso Serverless DB:", TURSO_URL);
} else {
  // Serverless platforms (e.g. Vercel) only allow writes to /tmp
  const isServerless = Boolean(process.env.VERCEL);
  const dbPath = isServerless
    ? "/tmp/blood_network.db"
    : path.join(__dirname, "../data/blood_network.db");
  if (isServerless) {
    console.warn(
      "⚠️  TURSO_DATABASE_URL is not set to a libsql:// URL — falling back to an EPHEMERAL SQLite file in /tmp (data will not persist between invocations). " +
      "Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN as plain values in your Vercel Project Settings -> Environment Variables."
    );
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  clientConfig = { url: `file:${dbPath}` };
  console.log("💾 Using Local SQLite DB:", dbPath);
}

export const db = createClient(clientConfig);

// ---------- Helper wrappers ----------
// libsql rejects `undefined` args — normalize to null everywhere.
const clean = (args) => (Array.isArray(args) ? args.map((a) => (a === undefined ? null : a)) : args);

export async function query(sql, args = []) {
  return await db.execute({ sql, args: clean(args) });
}
export async function get(sql, args = []) {
  const res = await db.execute({ sql, args: clean(args) });
  return res.rows[0] || null;
}
export async function all(sql, args = []) {
  const res = await db.execute({ sql, args: clean(args) });
  return res.rows;
}
export async function run(sql, args = []) {
  return await db.execute({ sql, args: clean(args) });
}

// ---------- Schema Initialization ----------
export async function initDB() {
  console.log("🔧 Initializing BloodOra database schema...");

  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      address_holding TEXT,
      division TEXT,
      district TEXT,
      upazila TEXT,
      union_area TEXT,
      blood_group TEXT,
      image_file TEXT NOT NULL DEFAULT 'default.jpg',
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'Both',
      can_donate INTEGER DEFAULT 0,
      last_donation TEXT,
      is_admin INTEGER DEFAULT 0,
      is_super_admin INTEGER DEFAULT 0,
      is_verified INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
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
      session_token TEXT,
      last_login_ip TEXT,
      last_login_device TEXT,
      last_login_at TEXT
    );
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_users_district ON users(district);`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_users_blood ON users(blood_group);`);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS blood_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_id INTEGER REFERENCES users(id),
      patient_name TEXT NOT NULL,
      patient_relation TEXT,
      blood_group TEXT NOT NULL,
      quantity TEXT DEFAULT '1 unit',
      hospital_name TEXT NOT NULL,
      hospital_address TEXT NOT NULL,
      contact_person TEXT NOT NULL,
      contact_phone TEXT NOT NULL,
      contact_email TEXT,
      is_urgent INTEGER DEFAULT 0,
      urgent_reason TEXT,
      needed_by TEXT NOT NULL,
      is_fulfilled INTEGER DEFAULT 0,
      fulfilled_at TEXT,
      fulfilled_by INTEGER REFERENCES users(id),
      location_division TEXT,
      location_district TEXT,
      location_upazila TEXT,
      additional_info TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_br_blood ON blood_requests(blood_group);`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_br_urgent ON blood_requests(is_urgent);`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_br_fulfilled ON blood_requests(is_fulfilled);`);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id),
      recipient_id INTEGER REFERENCES users(id),
      subject TEXT NOT NULL,
      content TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      is_admin_message INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      replied_to INTEGER REFERENCES messages(id)
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS anti_d_info (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      timing TEXT NOT NULL,
      dosage TEXT NOT NULL,
      image_file TEXT DEFAULT 'antid_default.jpg',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS site_notice (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      category TEXT,
      content TEXT NOT NULL,
      image_file TEXT,
      is_featured INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_name TEXT DEFAULT 'BloodOra',
      site_email TEXT DEFAULT 'info.bloodora@gmail.com',
      site_phone TEXT DEFAULT '+8801709202140',
      site_address TEXT DEFAULT 'Kalai,Rajshahi, Bangladesh',
      site_description TEXT DEFAULT 'Connecting blood donors to save lives across Bangladesh.',
      facebook_url TEXT DEFAULT 'https://www.facebook.com/profile.php?id=61575592734038',
      twitter_url TEXT DEFAULT '#',
      instagram_url TEXT DEFAULT '#',
      linkedin_url TEXT DEFAULT '#',
      bkash_merchant_number TEXT DEFAULT '01709202140',
      nagad_merchant_number TEXT DEFAULT '01800000000',
      upay_merchant_number TEXT DEFAULT '01600000000',
      rocket_merchant_number TEXT DEFAULT '01900000000',
      pathao_merchant_number TEXT DEFAULT '01500000000',
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      category TEXT,
      image_file TEXT DEFAULT 'default_product.jpg',
      stock INTEGER DEFAULT 0,
      is_available INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      guest_email TEXT,
      guest_name TEXT,
      guest_phone TEXT,
      subtotal_amount REAL DEFAULT 0,
      delivery_charge REAL DEFAULT 0,
      total_amount REAL NOT NULL,
      payment_method TEXT,
      payment_status TEXT DEFAULT 'pending',
      transaction_id TEXT,
      delivery_address TEXT,
      delivery_division TEXT,
      delivery_district TEXT,
      delivery_upazila TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      product_name TEXT,
      quantity INTEGER DEFAULT 1,
      price REAL NOT NULL
    );
  `);

  // Seed defaults
  const settings = await get("SELECT id FROM site_settings LIMIT 1");
  if (!settings) {
    await run(`INSERT INTO site_settings (site_name, site_email, site_phone, site_address) VALUES (?, ?, ?, ?)`, ["BloodOra", "info.bloodora@gmail.com", "+8801709202140", "Kalai,Rajshahi, Bangladesh"]);
    console.log("✅ Seeded site_settings");
  }
  const antid = await get("SELECT id FROM anti_d_info LIMIT 1");
  if (!antid) {
    await run(`INSERT INTO anti_d_info (title, description, timing, dosage) VALUES (?, ?, ?, ?)`, ["Anti-D Immunoglobulin Injection", "Anti-D injection is given to Rh-negative mothers to prevent Rh incompatibility issues during pregnancy.", "28 weeks of pregnancy and within 72 hours after delivery", "300 mcg (1500 IU) intramuscular injection"]);
    console.log("✅ Seeded anti_d_info");
  }
  const resCount = await get("SELECT COUNT(*) as c FROM resources");
  if (resCount && resCount.c == 0) {
    await run(`INSERT INTO resources (title, category, content, is_featured) VALUES (?, ?, ?, ?)`, ["Why Donate Blood?", "Donation", "Blood donation saves lives. One donation can help up to 3 people.", 1]);
    await run(`INSERT INTO resources (title, category, content, is_featured) VALUES (?, ?, ?, ?)`, ["Blood Donation Process", "Donation", "Step-by-step guide to donating blood safely.", 1]);
    await run(`INSERT INTO resources (title, category, content, is_featured) VALUES (?, ?, ?, ?)`, ["First Aid Basics", "First-Aid", "Essential first aid knowledge for emergencies.", 0]);
    await run(`INSERT INTO resources (title, category, content, is_featured) VALUES (?, ?, ?, ?)`, ["Healthy Lifestyle", "Health", "Tips for maintaining good health as a donor.", 0]);
    console.log("✅ Seeded resources");
  }
  const prodCount = await get("SELECT COUNT(*) as c FROM products");
  if (prodCount && prodCount.c == 0) {
    const samples = [
      ["Amaryl M 1mg Tablet", "Diabetes medicine - Glimepiride + Metformin. Pack of 30 tablets.", 245, "Medicine", 50],
      ["Uromax 0.4mg Capsule", "Tamsulosin for BPH treatment. 30 capsules.", 320, "Medicine", 30],
      ["CoralCal-DX 600mg", "Calcium + Vitamin D3 supplement. 30 tablets.", 180, "Supplements", 100],
      ["CoralCal-D 500mg", "Calcium supplement for bone health. 30 tablets.", 150, "Supplements", 80],
      ["AlphaPress 1mg", "Prazosin for hypertension. 30 tablets.", 210, "Medicine", 40],
      ["Bilastin 20mg", "Antihistamine for allergies. 10 tablets.", 120, "Medicine", 60],
      ["Rhophylac Anti-D 300mcg", "Anti-D Immunoglobulin injection.", 2850, "Medicine", 15],
      ["Surgel 40mg", "Esomeprazole for acidity. 14 capsules.", 95, "Medicine", 70],
      ["Digital BP Monitor", "Automatic upper arm blood pressure monitor with memory.", 2250, "Equipment", 20],
      ["First Aid Kit", "Complete emergency first aid box with 50+ items.", 850, "Healthcare", 25],
    ];
    for (const [name, desc, price, cat, stock] of samples) {
      await run(`INSERT INTO products (name, description, price, category, stock) VALUES (?, ?, ?, ?, ?)`, [name, desc, price, cat, stock]);
    }
    console.log("✅ Seeded 10 sample products");
  }

  await seedSuperAdmin();
  console.log("✅ Database initialization complete!");
}

// Creates/confirms a Super Admin account driven entirely by environment variables.
export async function seedSuperAdmin() {
  const email = (process.env.SUPER_ADMIN_EMAIL || "").trim().toLowerCase();
  if (!email) {
    console.log("ℹ️  SUPER_ADMIN_EMAIL not set — skipping super admin provisioning.");
    return;
  }
  const password = (process.env.SUPER_ADMIN_PASSWORD || "").trim();
  const name = (process.env.SUPER_ADMIN_NAME || "Super Admin").trim();
  const phone = (process.env.SUPER_ADMIN_PHONE || "+8801000000000").trim();

  const existing = await get("SELECT * FROM users WHERE email = ?", [email]);
  if (existing) {
    await run(
      "UPDATE users SET is_admin=1, is_super_admin=1, is_verified=1, can_donate=1 WHERE email=?",
      [email]
    );
    console.log("✅ Super Admin account confirmed:", email);
    return;
  }

  if (!password || password.length < 6) {
    console.warn(
      "⚠️  SUPER_ADMIN_EMAIL set but SUPER_ADMIN_PASSWORD is missing/short — skipping super admin provisioning."
    );
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await run(
    `INSERT INTO users (name, email, phone, blood_group, password_hash, role, age,
      is_admin, is_super_admin, is_verified, can_donate, district, upazila)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [name, email, phone, "O+", hash, "Both", 25, 1, 1, 1, 1, "Joypurhat", "Kalai"]
  );
  console.log("✅ Provisioned Super Admin:", email);
}

// Auto-init if run directly:  node src/db.js --init
if (process.argv.includes("--init")) {
  initDB().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
