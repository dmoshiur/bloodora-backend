/**
 * Shared domain types. Row-level types mirror the SQL schema (snake_case);
 * the repositories map them into these camelCase shapes for the services.
 */

export type Role = "user" | "admin" | "super_admin";

/** Identity remap: strips an index signature so Omit<> keeps concrete keys. */
export type NoIndex<T> = {
  [K in keyof T]: T[K];
};

export interface UserRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  password_hash: string;
  is_admin: number;
  is_super_admin: number;
  role: string;
  donation_role: string;
  blood_group: string | null;
  city: string | null;
  address_holding: string | null;
  division: string | null;
  district: string | null;
  upazila: string | null;
  union_area: string | null;
  can_donate: number;
  last_donation: string | null;
  age: number | null;
  date_of_birth: string | null;
  birth_certificate_number: string | null;
  bkash_number: string | null;
  nagad_number: string | null;
  upay_number: string | null;
  rocket_number: string | null;
  pathao_number: string | null;
  card_last_four: string | null;
  card_type: string | null;
  is_verified: number;
  image_file: string | null;
  session_token: string | null;
  created_at: string;
}

/** User shape safe to send to clients / use in session data. */
export type SafeUser = Omit<NoIndex<UserRow>, "password_hash" | "session_token">;

export interface ProductRow {
  id: string;
  slug: string;
  name: string;
  price: number;
  stock: number;
  category: string | null;
  description: string | null;
  image_file: string | null;
  is_active: number;
  sales_count: number;
  created_at: string;
}

export type Product = NoIndex<ProductRow> & { image: string | null };

export interface OrderRow {
  id: string;
  user_id: string;
  customer_name: string;
  customer_phone: string;
  address: string;
  city: string;
  division: string | null;
  district: string | null;
  upazila: string | null;
  payment_method: string;
  payment_ref: string | null;
  subtotal: number;
  delivery_fee: number;
  total: number;
  status: string;
  payment_status: string;
  note: string | null;
  created_at: string;
}

export interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  product_image: string | null;
  price: number;
  qty: number;
  line_total: number;
}

export interface Order extends NoIndex<OrderRow> {
  customer: { id: string; name: string; phone: string } | null;
  items: OrderItem[];
}

export interface OrderItem extends NoIndex<OrderItemRow> {}

export interface CartLine {
  id: string;
  name: string;
  slug: string;
  price: number;
  qty: number;
  image: string | null;
  stock: number;
}

export interface CartState {
  lines: CartLine[];
  count: number;
  subtotal: number;
  out_of_stock: CartLine[];
}

export interface BloodRequestRow {
  id: string;
  user_id: string | null;
  name: string | null;
  phone: string;
  hospital: string | null;
  patient_name: string | null;
  patient_relation: string | null;
  hospital_name: string | null;
  hospital_address: string | null;
  contact_person: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  urgent_reason: string | null;
  needed_by: string | null;
  additional_info: string | null;
  blood_group: string;
  units: number;
  quantity: string | null;
  division: string | null;
  district: string | null;
  upazila: string | null;
  location_division: string | null;
  location_district: string | null;
  location_upazila: string | null;
  urgent: number;
  status: string;
  is_fulfilled: number;
  fulfilled_at: string | null;
  fulfilled_by: string | null;
  note: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface BloodRequest extends NoIndex<BloodRequestRow> {
  user: { id: string; name: string } | null;
}

export interface ActivityRow {
  id: string;
  type: string;
  user_id: string | null;
  message: string;
  meta: string | null;
  created_at: string;
}

export interface MessageRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  subject: string;
  body: string;
  is_admin_message: number;
  is_admin_reply: number;
  replied_to: string | null;
  read_at: string | null;
  created_at: string;
}

export interface Message extends NoIndex<MessageRow> {
  sender: { id: string; name: string; role: string } | null;
}

// ---------- Live Messaging (support chat) ----------

export interface LiveSessionRow {
  id: string;
  session_key: string;
  user_id: string | null;
  visitor_name: string;
  last_message: string | null;
  last_message_at: string;
  unread_admin: number;
  unread_visitor: number;
  is_open: number;
  created_at: string;
}

export interface LiveMessageRow {
  id: string;
  session_key: string;
  sender_type: string;
  sender_name: string | null;
  body: string;
  is_read: number;
  created_at: string;
}

export interface LiveSession extends NoIndex<LiveSessionRow> {
  user: { id: string; name: string } | null;
}

export interface LiveMessage extends NoIndex<LiveMessageRow> {
  from: "visitor" | "admin";
  at: string;
}

// ---------- Uploads ----------

export interface UploadRow {
  id: string;
  filename: string;
  original_name: string | null;
  mime: string;
  size: number;
  data: Uint8Array;
  created_at: string;
}

export interface UploadMeta {
  id: string;
  filename: string;
  size: number;
  mime: string;
  url: string;
}

// ---------- Content ----------

export interface AntiDRow {
  id: string;
  title: string;
  description: string;
  timing: string;
  dosage: string;
  image_file: string | null;
  created_at: string;
}

export interface ResourceRow {
  id: string;
  title: string;
  category: string | null;
  content: string;
  summary: string | null;
  read_time: string | null;
  image_file: string | null;
  is_featured: number;
  source: string;
  created_at: string;
}

export interface SiteNoticeRow {
  id: string;
  content: string;
  active: number;
  updated_at: string;
}

export interface EmailLogRow {
  id: string;
  to_email: string | null;
  subject: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

export interface AiMessageRow {
  id: string;
  conversation_id: string;
  user_id: string | null;
  role: string;
  content: string;
  model: string | null;
  created_at: string;
}

// ---------- Site settings ----------

export interface SiteSettings {
  // identity / branding
  site_name: string;
  site_tagline: string | null;
  site_description: string | null;
  site_email: string | null;
  site_phone: string | null;
  site_address: string | null;
  facebook_url: string | null;
  twitter_url: string | null;
  instagram_url: string | null;
  linkedin_url: string | null;
  logo_file: string | null;
  favicon_file: string | null;
  brand_primary: string;
  brand_accent: string;
  brand_font_style: string;
  default_language: string;
  footer_note: string | null;
  primary_color: string;
  font_style: string;
  announcement: string | null;
  whatsapp: string | null;
  support_phone: string | null;
  email: string | null;
  address: string | null;
  language: string;
  // payment gateways
  bkash_merchant_number: string | null;
  nagad_merchant_number: string | null;
  upay_merchant_number: string | null;
  rocket_merchant_number: string | null;
  pathao_merchant_number: string | null;
  bKash_number: string | null;
  bKash_merchant: string | null;
  Nagad_number: string | null;
  Nagad_merchant: string | null;
  Rocket_number: string | null;
  Rocket_merchant: string | null;
  card_enabled: number;
  // delivery
  delivery_areas: string;
  delivery_fee: number;
  free_shipping_threshold: number;
  // smtp
  smtp_enabled: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  smtp_user: string;
  smtp_pass: string | null;
  smtp_from_name: string;
  smtp_from_email: string;
  // ai
  ai_enabled: number;
  ai_provider: string;
  ai_model: string;
  ai_base_url: string;
  ai_api_key: string | null;
  ai_temperature: number;
  ai_max_tokens: number;
  ai_persona: string | null;
  ai_prompts: string | null;
  // live features
  live_chat_enabled: number;
  live_activity_enabled: number;
}

export interface Activity {
  id: string;
  type: string;
  userId: string | null;
  user: { id: string; name: string } | null;
  message: string;
  meta: Record<string, unknown> | null;
  at: string;
}

export interface Stats {
  users: number;
  admins: number;
  superAdmins: number;
  donors: number;
  unverifiedUsers: number;
  products: number;
  lowStock: number;
  outOfStock: number;
  categories: number;
  orders: number;
  pendingOrders: number;
  deliveredOrders: number;
  revenue: number;
  pendingRequests: number;
  urgentRequests: number;
  requests: number;
  reviews: number;
  unreadMessages: number;
  unreadChat: number;
  totalActivities: number;
  today: { orders: number; revenue: number; users: number; requests: number };
}

export interface Dashboard {
  stats: Stats;
  recentOrders: (Order & { statusLabel?: string })[];
  recentUsers: (SafeUser & { isAdmin: boolean })[];
  lowStockProducts: { id: string; name: string; stock: number }[];
  recentRequests: BloodRequest[];
  latestActivities: Activity[];
  allUsers: SafeUser[];
  currentNotice: string | null;
  settings: SiteSettings;
}

export interface ReviewRow {
  id: string;
  product_id: string | null;
  user_id: string;
  author_name: string | null;
  kind: string;
  rating: number;
  title: string | null;
  body: string | null;
  status: string;
  is_approved: number;
  is_featured: number;
  admin_reply: string | null;
  admin_replied_at: string | null;
  created_at: string;
}

export interface Review extends NoIndex<ReviewRow> {
  user: { id: string; name: string; image: string | null } | null;
  verified: boolean;
}

export interface SettingsView extends SiteSettings {
  smtp_pass_display: string;
  ai_api_key_display: string;
  card_enabled_label: string;
}

export interface AiConfig {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  available: boolean;
}

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiResult {
  answer: string;
  model: string;
  tokens: number | null;
}
