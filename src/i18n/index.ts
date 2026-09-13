/**
 * Backend localization (English · বাংলা · العربية).
 *
 * The frontend renders three languages and switches the document to RTL for
 * Arabic, but every flash message it shows comes from the backend response
 * (`d.message`). Those strings were hardcoded English, so a Bangla or Arabic
 * visitor saw an English confirmation.
 *
 * Rules:
 *  - Only USER-FACING prose is translated (messages, notification titles,
 *    email subjects/bodies, validation complaints).
 *  - Machine-readable values are NEVER translated: error `code`, ids, enum
 *    values (`pending`, `bkash`), field names, JSON keys, URLs.
 *  - Unknown keys fall back to English, then to the key itself, so a missing
 *    translation can never break a response.
 *
 * Resolution order (see `resolveLanguage`): explicit `?lang=` → the
 * authenticated user's saved preference → `Accept-Language` → the
 * admin-configured site default → `en`.
 */
import { LANGUAGES } from "../data/constants.js";

export type Lang = "en" | "bn" | "ar";

export const SUPPORTED_LANGUAGES: Lang[] = ["en", "bn", "ar"];
export const DEFAULT_LANGUAGE: Lang = "en";

export const LANGUAGE_META: Record<Lang, { label: string; native: string; dir: "ltr" | "rtl" }> = {
  en: { label: "English", native: "English", dir: "ltr" },
  bn: { label: "Bengali", native: "বাংলা", dir: "ltr" },
  ar: { label: "Arabic", native: "العربية", dir: "rtl" },
};

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (SUPPORTED_LANGUAGES as string[]).includes(value.toLowerCase());
}

export function normalizeLang(value: unknown): Lang | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase().split(/[-_]/)[0];
  return isLang(code) ? (code as Lang) : null;
}

/**
 * Message catalogue. `{name}`, `{total}`, `{id}` … are substituted by `t()`.
 * Kept flat and explicit so a missing translation is greppable.
 */
type Params = Record<string, string | number | null | undefined>;

const CATALOG: Record<string, Record<Lang, string>> = {
  // ---------- auth ----------
  "auth.registered": {
    en: "✅ Registration successful! Welcome to BloodOra, {name}.",
    bn: "✅ নিবন্ধন সফল! BloodOra-তে স্বাগতম, {name}।",
    ar: "✅ تم التسجيل بنجاح! أهلًا بك في BloodOra، {name}.",
  },
  "auth.logged_in": {
    en: "👋 Welcome back, {name}!",
    bn: "👋 আবার স্বাগতম, {name}!",
    ar: "👋 أهلًا بعودتك، {name}!",
  },
  "auth.logged_out": {
    en: "👋 You have been logged out.",
    bn: "👋 আপনি লগআউট হয়েছেন।",
    ar: "👋 تم تسجيل خروجك.",
  },
  "auth.bad_credentials": {
    en: "Invalid email or password",
    bn: "ভুল ইমেইল অথবা পাসওয়ার্ড",
    ar: "البريد الإلكتروني أو كلمة المرور غير صحيحة",
  },
  "auth.email_taken": {
    en: "An account with this email already exists",
    bn: "এই ইমেইলে ইতিমধ্যে একটি অ্যাকাউন্ট আছে",
    ar: "يوجد حساب مسجّل بهذا البريد الإلكتروني",
  },
  "auth.unauthenticated": {
    en: "Authentication required",
    bn: "লগইন করা প্রয়োজন",
    ar: "يلزم تسجيل الدخول",
  },
  "auth.session_invalid": {
    en: "Session expired or invalid — please login again",
    bn: "সেশনের মেয়াদ শেষ বা অবৈধ — আবার লগইন করুন",
    ar: "انتهت الجلسة أو أنها غير صالحة — يرجى تسجيل الدخول مجددًا",
  },
  "auth.password_short": {
    en: "Password must be at least {min} characters",
    bn: "পাসওয়ার্ড কমপক্ষে {min} অক্ষরের হতে হবে",
    ar: "يجب أن تتكون كلمة المرور من {min} أحرف على الأقل",
  },
  "auth.password_changed": {
    en: "🔑 Password changed successfully.",
    bn: "🔑 পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে।",
    ar: "🔑 تم تغيير كلمة المرور بنجاح.",
  },
  "auth.password_current_wrong": {
    en: "Current password is incorrect",
    bn: "বর্তমান পাসওয়ার্ড ভুল",
    ar: "كلمة المرور الحالية غير صحيحة",
  },
  "auth.reset_sent": {
    en: "📧 If an account exists for {email}, a password reset link has been sent. The link expires in {minutes} minutes.",
    bn: "📧 {email} দিয়ে অ্যাকাউন্ট থাকলে পাসওয়ার্ড রিসেট লিংক পাঠানো হয়েছে। লিংকটি {minutes} মিনিটে মেয়াদোত্তীর্ণ হবে।",
    ar: "📧 إن كان هناك حساب مرتبط بـ {email} فقد أرسلنا رابط إعادة تعيين كلمة المرور. تنتهي صلاحيته بعد {minutes} دقيقة.",
  },
  "auth.reset_done": {
    en: "✅ Password reset successful. You can now login with your new password.",
    bn: "✅ পাসওয়ার্ড রিসেট সফল। এখন নতুন পাসওয়ার্ড দিয়ে লগইন করুন।",
    ar: "✅ تمت إعادة تعيين كلمة المرور. يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.",
  },
  "auth.reset_invalid": {
    en: "This reset link is invalid or has expired. Please request a new one.",
    bn: "এই রিসেট লিংকটি অবৈধ বা মেয়াদোত্তীর্ণ। নতুন লিংকের জন্য অনুরোধ করুন।",
    ar: "رابط إعادة التعيين غير صالح أو منتهي الصلاحية. يرجى طلب رابط جديد.",
  },
  "auth.verify_sent": {
    en: "📧 A verification link has been sent to {email}.",
    bn: "📧 {email} ঠিকানায় একটি যাচাই লিংক পাঠানো হয়েছে।",
    ar: "📧 تم إرسال رابط التحقق إلى {email}.",
  },
  "auth.verify_done": {
    en: "✅ Email verified. Thank you!",
    bn: "✅ ইমেইল যাচাই সম্পন্ন। ধন্যবাদ!",
    ar: "✅ تم التحقق من البريد الإلكتروني. شكرًا لك!",
  },
  "auth.security_password_reset": {
    en: "Your BloodOra password was reset",
    bn: "আপনার BloodOra পাসওয়ার্ড রিসেট করা হয়েছে",
    ar: "تمت إعادة تعيين كلمة مرور BloodOra الخاصة بك",
  },
  "auth.security_password_changed": {
    en: "Your BloodOra password was changed",
    bn: "আপনার BloodOra পাসওয়ার্ড পরিবর্তন করা হয়েছে",
    ar: "تم تغيير كلمة مرور BloodOra الخاصة بك",
  },
  "auth.security_new_login": {
    en: "A new login to your account",
    bn: "আপনার অ্যাকাউন্টে নতুন লগইন",
    ar: "تسجيل دخول جديد إلى حسابك",
  },

  // ---------- validation ----------
  "validation.failed": {
    en: "Validation failed",
    bn: "তথ্য যাচাই ব্যর্থ হয়েছে",
    ar: "فشل التحقق من البيانات",
  },
  "validation.required": {
    en: "{field} is required",
    bn: "{field} আবশ্যক",
    ar: "{field} مطلوب",
  },

  // ---------- orders / payments ----------
  "order.placed": {
    en: "✅ Order placed successfully! Admin will confirm your payment.",
    bn: "✅ অর্ডার সফলভাবে সম্পন্ন! অ্যাডমিন আপনার পেমেন্ট নিশ্চিত করবেন।",
    ar: "✅ تم إنشاء الطلب بنجاح! سيؤكد المشرف عملية الدفع.",
  },
  "order.empty_cart": {
    en: "⚠️ Your cart is empty!",
    bn: "⚠️ আপনার কার্ট খালি!",
    ar: "⚠️ سلة التسوق فارغة!",
  },
  "order.area_not_served": {
    en: "❌ Sorry! Home delivery is currently ONLY available in {area} Upazila.",
    bn: "❌ দুঃখিত! বর্তমানে হোম ডেলিভারি শুধুমাত্র {area} উপজেলায় available।",
    ar: "❌ عذرًا! التوصيل المنزلي متاح حاليًا في {area} فقط.",
  },
  "order.out_of_stock": {
    en: "❌ {product} does not have enough stock (requested {requested}, available {available}).",
    bn: "❌ {product}-এর পর্যাপ্ত স্টক নেই (চাওয়া {requested}, আছে {available})।",
    ar: "❌ لا تتوفر كمية كافية من {product} (المطلوب {requested}، المتاح {available}).",
  },
  "order.unavailable": {
    en: "❌ {product} is no longer available.",
    bn: "❌ {product} আর available নয়।",
    ar: "❌ {product} لم يعد متاحًا.",
  },
  "order.not_found": {
    en: "Order not found.",
    bn: "অর্ডার পাওয়া যায়নি।",
    ar: "لم يتم العثور على الطلب.",
  },
  "order.cancelled": {
    en: "✅ Order cancelled. Stock has been restored.",
    bn: "✅ অর্ডার বাতিল হয়েছে। স্টক ফিরিয়ে দেওয়া হয়েছে।",
    ar: "✅ تم إلغاء الطلب وإعادة المخزون.",
  },
  "order.not_cancellable": {
    en: "⚠️ This order is already being processed — please use Live Messaging to reach support.",
    bn: "⚠️ এই অর্ডারটি ইতিমধ্যে প্রক্রিয়াধীন — সাপোর্টের জন্য Live Messaging ব্যবহার করুন।",
    ar: "⚠️ هذا الطلب قيد المعالجة بالفعل — يرجى استخدام المراسلة المباشرة للتواصل مع الدعم.",
  },
  "order.own_only": {
    en: "\u274C You can only manage your own orders.",
    bn: "\u274C \u0986\u09AA\u09A8\u09BF \u09B6\u09C1\u09A7\u09C1\u09AE\u09BE\u09A4\u09CD\u09B0 \u09A8\u09BF\u099C\u09C7\u09B0 \u0985\u09B0\u09CD\u09A1\u09BE\u09B0 \u09AA\u09B0\u09BF\u099A\u09BE\u09B2\u09A8\u09BE \u0995\u09B0\u09A4\u09C7 \u09AA\u09BE\u09B0\u09AC\u09C7\u09A8\u0964",
    ar: "\u274C \u064A\u0645\u0643\u0646\u0643 \u0625\u062F\u0627\u0631\u0629 \u0637\u0644\u0628\u0627\u062A\u0643 \u0623\u0646\u062A \u0641\u0642\u0637.",
  },
  "order.status_updated": {
    en: "✅ Order status updated to {status}.",
    bn: "✅ অর্ডারের স্ট্যাটাস {status} করা হয়েছে।",
    ar: "✅ تم تحديث حالة الطلب إلى {status}.",
  },
  "payment.confirmed": {
    en: "✅ Payment confirmed!",
    bn: "✅ পেমেন্ট নিশ্চিত করা হয়েছে!",
    ar: "✅ تم تأكيد الدفع!",
  },
  "payment.already_confirmed": {
    en: "ℹ️ Payment already confirmed.",
    bn: "ℹ️ পেমেন্ট আগেই নিশ্চিত করা হয়েছে।",
    ar: "ℹ️ تم تأكيد الدفع مسبقًا.",
  },
  "payment.refunded": {
    en: "💸 Refund of {amount} recorded for this order.",
    bn: "💸 এই অর্ডারের জন্য {amount} টাকা ফেরত রেকর্ড করা হয়েছে।",
    ar: "💸 تم تسجيل استرداد بمبلغ {amount} لهذا الطلب.",
  },
  "payment.duplicate": {
    en: "⚠️ This payment was already recorded — no duplicate transaction was created.",
    bn: "⚠️ এই পেমেন্টটি আগেই রেকর্ড হয়েছে — নতুন কোনো লেনদেন তৈরি হয়নি।",
    ar: "⚠️ تم تسجيل هذه الدفعة بالفعل — لم يتم إنشاء عملية مكررة.",
  },

  // ---------- notifications ----------
  "notify.order.placed.title": {
    en: "Order received",
    bn: "অর্ডার গৃহীত হয়েছে",
    ar: "تم استلام الطلب",
  },
  "notify.order.placed.body": {
    en: "Your order {id} for {total} has been placed and is awaiting payment confirmation.",
    bn: "{total} টাকার আপনার অর্ডার {id} সম্পন্ন হয়েছে এবং পেমেন্ট নিশ্চিতকরণের অপেক্ষায় আছে।",
    ar: "طلبك {id} بمبلغ {total} تم إنشاؤه وهو بانتظار تأكيد الدفع.",
  },
  "notify.order.status.title": {
    en: "Order update",
    bn: "অর্ডার হালনাগাদ",
    ar: "تحديث الطلب",
  },
  "notify.order.status.body": {
    en: "Order {id} is now {status}.",
    bn: "অর্ডার {id} এখন {status} অবস্থায় আছে।",
    ar: "الطلب {id} أصبح بحالة {status}.",
  },
  "notify.payment.success.title": {
    en: "Payment confirmed",
    bn: "পেমেন্ট নিশ্চিত",
    ar: "تم تأكيد الدفع",
  },
  "notify.payment.success.body": {
    en: "We confirmed your payment of {amount} for order {id}. Thank you!",
    bn: "অর্ডার {id}-এর জন্য আপনার {amount} টাকার পেমেন্ট নিশ্চিত করা হয়েছে। ধন্যবাদ!",
    ar: "أكدنا دفعك بمبلغ {amount} للطلب {id}. شكرًا لك!",
  },
  "notify.blood.created.title": {
    en: "Blood request posted",
    bn: "রক্তের আবেদন প্রকাশিত হয়েছে",
    ar: "تم نشر طلب الدم",
  },
  "notify.blood.created.body": {
    en: "Your request for {units} unit(s) of {group} blood is now visible to donors.",
    bn: "{group} রক্তের {units} ইউনিটের আপনার আবেদনটি এখন দাতাদের কাছে দৃশ্যমান।",
    ar: "طلبك لـ {units} وحدة من فصيلة {group} أصبح مرئيًا للمتبرعين.",
  },
  "notify.blood.fulfilled.title": {
    en: "Blood request fulfilled",
    bn: "রক্তের আবেদন পূরণ হয়েছে",
    ar: "تم تلبية طلب الدم",
  },
  "notify.blood.fulfilled.body": {
    en: "The request for {group} blood was marked as fulfilled.",
    bn: "{group} রক্তের আবেদনটি পূরণ হিসেবে চিহ্নিত করা হয়েছে।",
    ar: "تم وضع علامة «مُلبّى» على طلب فصيلة {group}.",
  },
  "notify.message.reply.title": {
    en: "New reply to your message",
    bn: "আপনার বার্তায় নতুন উত্তর",
    ar: "رد جديد على رسالتك",
  },
  "notify.message.reply.body": {
    en: "The support team replied to “{subject}”.",
    bn: "সাপোর্ট টিম “{subject}” বার্তার উত্তর দিয়েছে।",
    ar: "ردّ فريق الدعم على «{subject}».",
  },
  "notify.review.approved.title": {
    en: "Your review was published",
    bn: "আপনার রিভিউ প্রকাশিত হয়েছে",
    ar: "تم نشر تقييمك",
  },
  "notify.review.approved.body": {
    en: "Thanks! Your review is now public.",
    bn: "ধন্যবাদ! আপনার রিভিউ এখন সর্বসাধারণের জন্য দৃশ্যমান।",
    ar: "شكرًا لك! أصبح تقييمك ظاهرًا للجميع.",
  },
  "notify.donor.verified.title": {
    en: "You are a verified donor",
    bn: "আপনি এখন যাচাইকৃত দাতা",
    ar: "أنت الآن متبرع موثّق",
  },
  "notify.donor.verified.body": {
    en: "Your donor profile was verified. You now appear in the public donor directory.",
    bn: "আপনার দাতা প্রোফাইল যাচাই করা হয়েছে। আপনি এখন পাবলিক ডোনার ডিরেক্টরিতে দেখা যাবেন।",
    ar: "تم التحقق من ملفك كمتبرع. ستظهر الآن في دليل المتبرعين العام.",
  },
  "notify.admin.new_order.title": {
    en: "New order",
    bn: "নতুন অর্ডার",
    ar: "طلب جديد",
  },
  "notify.admin.new_order.body": {
    en: "{name} placed order {id} for {total}.",
    bn: "{name} {total} টাকার অর্ডার {id} সম্পন্ন করেছেন।",
    ar: "قام {name} بإنشاء الطلب {id} بمبلغ {total}.",
  },
  "notify.admin.new_request.title": {
    en: "New blood request",
    bn: "নতুন রক্তের আবেদন",
    ar: "طلب دم جديد",
  },
  "notify.admin.new_request.body": {
    en: "{group} blood · {units} unit(s) · {where}",
    bn: "{group} রক্ত · {units} ইউনিট · {where}",
    ar: "فصيلة {group} · {units} وحدة · {where}",
  },
  "notify.admin.chat.title": {
    en: "New live-chat message",
    bn: "লাইভ চ্যাটে নতুন বার্তা",
    ar: "رسالة جديدة في الدردشة المباشرة",
  },
  "notify.admin.chat.body": {
    en: "{name} messaged the support desk.",
    bn: "{name} সাপোর্ট ডেস্কে বার্তা পাঠিয়েছেন।",
    ar: "أرسل {name} رسالة إلى مكتب الدعم.",
  },
  "notify.admin.announcement.title": {
    en: "Announcement",
    bn: "ঘোষণা",
    ar: "إعلان",
  },

  // ---------- chat ----------
  "chat.empty": {
    en: "❌ Message cannot be empty.",
    bn: "❌ বার্তা খালি হতে পারবে না।",
    ar: "❌ لا يمكن أن تكون الرسالة فارغة.",
  },
  "chat.too_long": {
    en: "❌ Message too long (max {max} characters).",
    bn: "❌ বার্তা অনেক দীর্ঘ (সর্বোচ্চ {max} অক্ষর)।",
    ar: "❌ الرسالة طويلة جدًا (الحد الأقصى {max} حرف).",
  },
  "chat.closed": {
    en: "This conversation is closed.",
    bn: "এই কথোপকথনটি বন্ধ করা হয়েছে।",
    ar: "هذه المحادثة مغلقة.",
  },
  "chat.greeting": {
    en: "Assalamu alaikum! This is the BloodOra live support desk. A human from the admin team will answer — usually within a few minutes. For urgent blood, please also post a request.",
    bn: "আসসালামু আলাইকুম! এটি BloodOra লাইভ সাপোর্ট ডেস্ক। অ্যাডমিন টিমের একজন সদস্য উত্তর দেবেন — সাধারণত কয়েক মিনিটের মধ্যে। জরুরি রক্তের জন্য একটি আবেদনও পোস্ট করুন।",
    ar: "السلام عليكم! هذا مكتب الدعم المباشر في BloodOra. سيجيبك أحد أعضاء الفريق خلال دقائق عادةً. للدم العاجل يرجى نشر طلب أيضًا.",
  },

  // ---------- email templates ----------
  // Subjects and bodies are translated; the reset link, order id and every
  // machine value are interpolated, never localized.
  "email.footer": {
    en: "You are receiving this email because you have a BloodOra account.",
    bn: "আপনার BloodOra অ্যাকাউন্ট থাকায় আপনি এই ইমেইলটি পেয়েছেন।",
    ar: "تصلك هذه الرسالة لأن لديك حسابًا في BloodOra.",
  },
  "email.welcome.subject": {
    en: "Welcome to BloodOra, {name}",
    bn: "BloodOra-তে স্বাগতম, {name}",
    ar: "أهلًا بك في BloodOra، {name}",
  },
  "email.welcome.body": {
    en: "Your account is ready. You can now post blood requests, order from the medical shop and message the support desk.",
    bn: "আপনার অ্যাকাউন্ট প্রস্তুত। এখন আপনি রক্তের আবেদন করতে, মেডিকেল শপ থেকে অর্ডার করতে এবং সাপোর্ট ডেস্কে বার্তা পাঠাতে পারবেন।",
    ar: "حسابك جاهز. يمكنك الآن نشر طلبات الدم، والطلب من المتجر الطبي، ومراسلة فريق الدعم.",
  },
  "email.verify.subject": {
    en: "Verify your email address",
    bn: "আপনার ইমেইল ঠিকানা যাচাই করুন",
    ar: "تحقق من بريدك الإلكتروني",
  },
  "email.verify.body": {
    en: "Confirm this email address belongs to you. The link expires in {hours} hours.",
    bn: "নিশ্চিত করুন যে এই ইমেইল ঠিকানাটি আপনার। লিংকটি {hours} ঘণ্টায় মেয়াদোত্তীর্ণ হবে।",
    ar: "أكّد أن هذا البريد يعود لك. تنتهي صلاحية الرابط خلال {hours} ساعة.",
  },
  "email.verify.cta": { en: "Verify email", bn: "ইমেইল যাচাই করুন", ar: "تحقق من البريد" },
  "email.reset.subject": {
    en: "Reset your BloodOra password",
    bn: "আপনার BloodOra পাসওয়ার্ড রিসেট করুন",
    ar: "إعادة تعيين كلمة مرور BloodOra",
  },
  "email.reset.body": {
    en: "We received a request to reset your password. This link expires in {minutes} minutes and can be used once.",
    bn: "আমরা আপনার পাসওয়ার্ড রিসেটের একটি অনুরোধ পেয়েছি। লিংকটি {minutes} মিনিটে মেয়াদোত্তীর্ণ হবে এবং একবারই ব্যবহার করা যাবে।",
    ar: "وصلنا طلب لإعادة تعيين كلمة مرورك. تنتهي صلاحية الرابط خلال {minutes} دقيقة ويمكن استخدامه مرة واحدة.",
  },
  "email.reset.cta": { en: "Choose a new password", bn: "নতুন পাসওয়ার্ড দিন", ar: "اختر كلمة مرور جديدة" },
  "email.reset.ignore": {
    en: "If you did not request this, you can safely ignore this email — your password will not change.",
    bn: "আপনি এই অনুরোধ না করে থাকলে ইমেইলটি উপেক্ষা করুন — আপনার পাসওয়ার্ড পরিবর্তন হবে না।",
    ar: "إن لم تطلب ذلك فتجاهل هذه الرسالة — لن تتغير كلمة مرورك.",
  },
  "email.password_changed.subject": {
    en: "Your password was changed",
    bn: "আপনার পাসওয়ার্ড পরিবর্তন হয়েছে",
    ar: "تم تغيير كلمة مرورك",
  },
  "email.password_changed.body": {
    en: "The password for your BloodOra account was changed on {date}. If this was not you, contact the support desk immediately.",
    bn: "{date} তারিখে আপনার BloodOra অ্যাকাউন্টের পাসওয়ার্ড পরিবর্তন করা হয়েছে। এটি আপনি না করে থাকলে এখনই সাপোর্ট ডেস্কে যোগাযোগ করুন।",
    ar: "تم تغيير كلمة مرور حسابك في {date}. إن لم يكن ذلك من فعلك فتواصل مع الدعم فورًا.",
  },
  "email.new_login.subject": { en: "A new sign-in to your account", bn: "আপনার অ্যাকাউন্টে নতুন লগইন", ar: "تسجيل دخول جديد إلى حسابك" },
  "email.new_login.body": {
    en: "We saw a new sign-in to your BloodOra account on {date}.",
    bn: "আমরা {date} তারিখে আপনার BloodOra অ্যাকাউন্টে একটি নতুন লগইন দেখেছি।",
    ar: "رصدنا تسجيل دخول جديدًا إلى حسابك في {date}.",
  },
  "email.order.subject": { en: "BloodOra order {id}", bn: "BloodOra অর্ডার {id}", ar: "طلب BloodOra رقم {id}" },
  "email.order.body": {
    en: "Thank you, {name}! Your order has been placed and is awaiting payment confirmation.",
    bn: "ধন্যবাদ, {name}! আপনার অর্ডারটি সম্পন্ন হয়েছে এবং পেমেন্ট নিশ্চিতকরণের অপেক্ষায় আছে।",
    ar: "شكرًا لك، {name}! تم إنشاء طلبك وهو بانتظار تأكيد الدفع.",
  },
  "email.order.status": {
    en: "Order {id} is now {status}.",
    bn: "অর্ডার {id} এখন {status} অবস্থায়।",
    ar: "الطلب {id} أصبح بحالة {status}.",
  },
  "email.payment.subject": { en: "Payment confirmed — order {id}", bn: "পেমেন্ট নিশ্চিত — অর্ডার {id}", ar: "تم تأكيد الدفع — الطلب {id}" },
  "email.payment.body": {
    en: "We confirmed your payment of {amount} for order {id}.",
    bn: "অর্ডার {id}-এর জন্য আপনার {amount} টাকার পেমেন্ট নিশ্চিত করা হয়েছে।",
    ar: "أكدنا دفعك بمبلغ {amount} للطلب {id}.",
  },
  "email.request.subject": { en: "Your blood request was posted", bn: "আপনার রক্তের আবেদন প্রকাশিত হয়েছে", ar: "تم نشر طلب الدم الخاص بك" },
  "email.request.body": {
    en: "Your request for {units} unit(s) of {group} blood is now visible to verified donors.",
    bn: "{group} রক্তের {units} ইউনিটের আপনার আবেদনটি এখন যাচাইকৃত দাতাদের কাছে দৃশ্যমান।",
    ar: "طلبك لـ {units} وحدة من فصيلة {group} أصبح مرئيًا للمتبرعين الموثّقين.",
  },
  "email.reply.subject": { en: "Reply to “{subject}”", bn: "“{subject}” বার্তার উত্তর", ar: "رد على «{subject}»" },
  "email.admin.subject": { en: "[BloodOra] {title}", bn: "[BloodOra] {title}", ar: "[BloodOra] {title}" },

  // ---------- generic ----------
  "error.not_found": { en: "Not found", bn: "পাওয়া যায়নি", ar: "غير موجود" },
  "error.forbidden": { en: "You do not have permission to do that", bn: "এটি করার অনুমতি আপনার নেই", ar: "ليست لديك صلاحية للقيام بذلك" },
  "error.admin_only": { en: "Admin access required", bn: "অ্যাডমিন অ্যাক্সেস প্রয়োজন", ar: "مطلوب صلاحية مسؤول" },
  "error.rate_limited": {
    en: "Too many requests — please slow down",
    bn: "অনেক বেশি অনুরোধ — একটু ধীরে চেষ্টা করুন",
    ar: "طلبات كثيرة جدًا — يرجى المحاولة لاحقًا",
  },
  "error.db_not_ready": {
    en: "The service is temporarily unavailable. Please try again in a moment.",
    bn: "সেবাটি সাময়িকভাবে পাওয়া যাচ্ছে না। কিছুক্ষণ পর আবার চেষ্টা করুন।",
    ar: "الخدمة غير متاحة مؤقتًا. يرجى المحاولة بعد قليل.",
  },
};

/** Translate `key` into `lang`, substituting `{placeholders}`. */
export function translate(lang: Lang | string | null | undefined, key: string, params: Params = {}): string {
  const l: Lang = normalizeLang(lang) ?? DEFAULT_LANGUAGE;
  const template = CATALOG[key]?.[l] ?? CATALOG[key]?.[DEFAULT_LANGUAGE] ?? key;
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = params[name];
    return v === null || v === undefined ? `{${name}}` : String(v);
  });
}

/** A translator bound to one language (handy inside services). */
export function translator(lang: Lang | string | null | undefined) {
  const l: Lang = normalizeLang(lang) ?? DEFAULT_LANGUAGE;
  return (key: string, params: Params = {}) => translate(l, key, params);
}

/** The catalogue keys — used by tests and the API docs. */
export function catalogKeys(): string[] {
  return Object.keys(CATALOG);
}

/** Every supported language with its direction (for API consumers). */
export function languageList() {
  return SUPPORTED_LANGUAGES.map((code) => ({ code, ...LANGUAGE_META[code] }));
}

export { LANGUAGES };
