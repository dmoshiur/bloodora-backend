import { settingsRepo } from "../repos/settings.repo.js";
import { uploadRepo } from "../repos/upload.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { ApiError } from "../utils/errors.js";
import { str } from "../utils/validate.js";
import type { SafeUser, SettingsView, SiteSettings } from "../types.js";

const INT_KEYS = ["delivery_fee", "free_shipping_threshold", "smtp_port"] as const;
const BOOL_KEYS = ["card_enabled", "smtp_enabled", "smtp_secure"] as const;

const FONT_STYLES = ["default", "serif", "rounded", "compact"];
const LANGUAGES = ["en", "bn", "ar"];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

function normalize(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export const settingsService = {
  /** Internal, unmasked settings (used by other services). */
  async getInternal(): Promise<SiteSettings> {
    const db = await settingsRepo.all();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(db)) {
      out[k] = v === "" ? null : v;
    }
    for (const k of INT_KEYS) {
      const n = Number(out[k]);
      out[k] = Number.isFinite(n) ? n : k === "smtp_port" ? 587 : 0;
    }
    for (const k of BOOL_KEYS) {
      out[k] = ["1", "true", "yes", "on"].includes(String(out[k] || "")) ? 1 : 0;
    }
    return out as unknown as SiteSettings;
  },

  /** Public view: secrets masked. */
  async publicView(): Promise<SettingsView> {
    const s = await this.getInternal();
    return {
      ...s,
      smtp_pass_display: s.smtp_pass ? "••••••••" : "",
      ai_api_key_display: s.ai_api_key ? "••••••••" : "",
      card_enabled_label: s.card_enabled ? "enabled" : "disabled",
    };
  },

  async update(actor: SafeUser, body: Record<string, unknown>): Promise<SettingsView> {
    const current = await this.getInternal();
    const changes: Record<string, string | null> = {};

    for (const key of Object.keys(body)) {
      const raw = body[key];
      if (raw === undefined) continue;
      const value = normalize(raw);

      // "••••••••" placeholder means "keep the existing secret"
      if (value === "••••••••" || value === "********") continue;

      switch (key) {
        case "primary_color":
          if (value !== null && !HEX_COLOR.test(value)) {
            throw ApiError.badRequest("primary_color must be a hex color like #c62828", "BAD_COLOR");
          }
          break;
        case "font_style":
          if (value !== null && !FONT_STYLES.includes(value)) {
            throw ApiError.badRequest(`font_style must be one of: ${FONT_STYLES.join(", ")}`, "BAD_FONT_STYLE");
          }
          break;
        case "language":
          if (value !== null && !LANGUAGES.includes(value)) {
            throw ApiError.badRequest(`language must be one of: ${LANGUAGES.join(", ")}`, "BAD_LANGUAGE");
          }
          break;
        case "delivery_fee":
        case "free_shipping_threshold":
        case "smtp_port": {
          if (value !== null) {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0) {
              throw ApiError.badRequest(`${key} must be a non-negative number`, "BAD_NUMBER");
            }
            changes[key] = String(Math.trunc(n));
          } else {
            changes[key] = null;
          }
          continue;
        }
        case "card_enabled":
        case "smtp_enabled":
        case "smtp_secure": {
          changes[key] = ["1", "true", "yes", "on"].includes(String(raw).toLowerCase()) ? "1" : "0";
          continue;
        }
      }
      changes[key] = value;
    }

    if (Object.keys(changes).length === 0) {
      return this.publicView();
    }

    await settingsRepo.setMany(changes);
    const touched = Object.keys(changes).filter((k) => !["smtp_pass", "ai_api_key"].includes(k));
    if (touched.length > 0) {
      await activityRepo.create("settings", actor.id, `Site settings updated: ${touched.join(", ")}`, { keys: touched });
    }
    if (changes.smtp_pass !== undefined || changes.ai_api_key !== undefined) {
      await activityRepo.create("settings", actor.id, "A stored secret was rotated");
    }

    return this.publicView();
  },

  async replaceLogo(actor: SafeUser, imageFile: string): Promise<SettingsView> {
    const current = await this.getInternal();
    const changes: Record<string, string | null> = { logo_file: imageFile };
    await settingsRepo.setMany(changes);
    if (current.logo_file) {
      await uploadRepo.delete(current.logo_file).catch(() => {});
    }
    await activityRepo.create("settings", actor.id, "Site logo updated");
    return this.publicView();
  },
};
