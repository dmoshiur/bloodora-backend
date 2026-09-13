import type { NextFunction, Request, Response } from "express";
import { DEFAULT_LANGUAGE, LANGUAGE_META, normalizeLang, translate, type Lang } from "../i18n/index.js";
import { settingsRepo } from "../repos/settings.repo.js";
import { str } from "../utils/validate.js";

/**
 * Language resolution for user-facing backend text.
 *
 * Precedence:
 *   1. `?lang=bn` (or a `lang` field in a JSON/urlencoded body) — an explicit
 *      request always wins, which is how the frontend's language switcher can
 *      drive backend messages without a redeploy;
 *   2. the authenticated user's saved preference (`users.language`), applied by
 *      the auth middleware once the user is known;
 *   3. `Accept-Language` (browsers/API clients);
 *   4. the admin-configured site default (`settings.default_language`);
 *   5. `en`.
 *
 * The site default is cached in-process for 30 s: it is display metadata, not
 * authoritative state, so a cold instance reading it once is both cheap and
 * safe (a change is visible within one TTL everywhere).
 */

/**
 * The fields are declared OPTIONAL on purpose. Making them required would force
 * every `(req: Request, res: Response)` handler in the codebase to satisfy a
 * shape Express itself never guarantees (declaration merging applies to the
 * interface everywhere, including places that construct a Request-like object).
 * `languageMiddleware` always populates them before any route runs; `tr()` is
 * the null-safe accessor for handlers and services.
 */
declare module "express" {
  interface Request {
    lang?: Lang;
    langDir?: "ltr" | "rtl";
    t?: (key: string, params?: Record<string, string | number | null | undefined>) => string;
  }
}

/** Null-safe translation for a request (falls back to the English catalogue). */
export function tr(
  req: { lang?: string | null; t?: (key: string, params?: Record<string, string | number | null | undefined>) => string } | undefined,
  key: string,
  params: Record<string, string | number | null | undefined> = {},
): string {
  if (req?.t) return req.t(key, params);
  return translate(req?.lang ?? DEFAULT_LANGUAGE, key, params);
}

/** The request's resolved language, always a supported code. */
export function langOf(req: { lang?: string | null } | undefined): Lang {
  return normalizeLang(req?.lang) ?? DEFAULT_LANGUAGE;
}

let siteDefaultCache: { value: Lang; at: number } | null = null;
const SITE_DEFAULT_TTL_MS = 30_000;

async function siteDefaultLanguage(): Promise<Lang> {
  const now = Date.now();
  if (siteDefaultCache && now - siteDefaultCache.at < SITE_DEFAULT_TTL_MS) return siteDefaultCache.value;
  let value: Lang = DEFAULT_LANGUAGE;
  try {
    const raw = await settingsRepo.get("default_language");
    value = normalizeLang(raw) ?? DEFAULT_LANGUAGE;
  } catch {
    /* settings unavailable → fall back to English */
  }
  siteDefaultCache = { value, at: now };
  return value;
}

/** Drop the cache (used after an admin changes `default_language`). */
export function invalidateLanguageCache(): void {
  siteDefaultCache = null;
}

function fromAcceptLanguage(header: string | undefined): Lang | null {
  if (!header) return null;
  // "en-US,en;q=0.9,bn;q=0.8" → best supported match, honouring q ordering.
  const parts = header
    .split(",")
    .map((p) => {
      const [tag, ...params] = p.trim().split(";");
      const q = params.find((x) => x.trim().startsWith("q="));
      return { tag: tag.trim(), q: q ? Number(q.slice(2)) || 0 : 1 };
    })
    .filter((p) => p.tag && p.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const p of parts) {
    const lang = normalizeLang(p.tag);
    if (lang) return lang;
  }
  return null;
}

export function bindTranslator(req: Request, lang: Lang): void {
  req.lang = lang;
  req.langDir = LANGUAGE_META[lang].dir;
  req.t = (key, params) => translate(lang, key, params);
}

export async function languageMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const explicit =
      normalizeLang(str(req.query.lang)) ??
      normalizeLang(str((req.body as Record<string, unknown> | undefined)?.lang));
    if (explicit) {
      bindTranslator(req, explicit);
      next();
      return;
    }
    const header = fromAcceptLanguage(req.headers["accept-language"]);
    bindTranslator(req, header ?? (await siteDefaultLanguage()));
    next();
  } catch {
    bindTranslator(req, DEFAULT_LANGUAGE);
    next();
  }
}

/**
 * Refine the language once the caller is authenticated. An explicit `?lang=`
 * still wins (a Bangla-speaking admin may be helping an Arabic-speaking user).
 */
export function applyUserLanguage(req: Request, userLang: unknown): void {
  if (str(req.query.lang) || str((req.body as Record<string, unknown> | undefined)?.lang)) return;
  const lang = normalizeLang(userLang);
  if (lang && lang !== req.lang) bindTranslator(req, lang);
}

/** Translate without a request context (background jobs, cron, emails). */
export function tIn(lang: Lang | string | null | undefined, key: string, params?: Record<string, string | number | null | undefined>): string {
  return translate(lang, key, params);
}
