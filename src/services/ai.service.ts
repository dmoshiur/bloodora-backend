import { settingsService } from "./settings.service.js";
import { loadSettings } from "./meta.service.js";
import { aiKnowledgeService } from "./aiKnowledge.service.js";
import { aiMessageRepo } from "../repos/aiMessage.repo.js";
import { navigationService } from "./navigation.service.js";
import { extractAnswer, sanitizeAnswer } from "./aiSanitize.js";
import { config } from "../config/env.js";
import { ApiError, randomId } from "../utils/errors.js";
import { str } from "../utils/validate.js";
import { logger } from "../utils/logger.js";
import type { AiConfig, AiMessage, AiResult, SafeUser } from "../types.js";

const MAX_CONTEXT_MESSAGES = 12;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_ANSWER_CHARS = 4000;

export const DEFAULT_MODEL = "qwen/qwen3.6-27b";

/** Models safe to offer in the Admin dropdown (Groq-served). */
export const MODEL_CHOICES = [
  { id: "qwen/qwen3.6-27b", label: "Qwen3.6 27B (Groq) — default", note: "262K context, strong multilingual." },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B (Groq)", note: "Reasoning model, higher latency." },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B (Groq)", note: "Fast, lightweight." },
  { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B Versatile (Groq)", note: "General purpose fallback." },
  { id: "moonshotai/kimi-k2-instruct-0905", label: "Kimi K2 Instruct (Groq)", note: "Long-context alternative." },
];

const LANG_NOTE: Record<string, string> = {
  en: "Answer in English.",
  bn: "উত্তরটি বাংলায় দিন। Answer in Bengali (Bangla).",
  ar: "أجب باللغة العربية. Answer in Arabic.",
};

/** Suggested widget chips (admin-editable, newline separated). */
function parsePrompts(raw: string | null | undefined): string[] {
  const list = String(raw || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length
    ? list
    : [
        "How do I request blood urgently?",
        "Open the medical shop",
        "When is Anti-D given during pregnancy?",
        "Who can receive O- blood?",
        "What is the delivery charge?",
        "How do I become a verified donor?",
      ];
}

/**
 * Parse markdown links out of the reply and enrich them with page titles.
 *
 * Titles come from the navigation table (with the built-in catalogue as its
 * seed), so a page an admin renamed or hid is reflected here too.
 */
async function extractLinks(text: string): Promise<{ label: string; path: string; title: string }[]> {
  const out: { label: string; path: string; title: string }[] = [];
  const seen = new Set<string>();
  let index: Map<string, string>;
  try {
    index = await navigationService.pathIndex();
  } catch {
    index = new Map();
  }
  const re = /\[([^\]]+)\]\((\/[^\s)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || "")) !== null) {
    const path = m[2].split("?")[0].replace(/[#:].*$/, "");
    if (seen.has(path)) continue;
    seen.add(path);
    let title = index.get(path) || "";
    if (!title) {
      // Parameterized catalogue entries ("/blood-request/:id") match by prefix.
      for (const [known, knownTitle] of index) {
        if (known.includes("/:") && path.startsWith(known.split("/:")[0])) {
          title = knownTitle;
          break;
        }
      }
    }
    out.push({ label: m[1], path: m[2], title: title || m[1] });
  }
  return out;
}

function maskKey(key: string | null | undefined): { masked: string; set: boolean } {
  const k = key || "";
  return {
    masked: k ? `${k.slice(0, 6)}${"•".repeat(10)}${k.slice(-4)}` : "",
    set: Boolean(k),
  };
}

export interface ChatTurn {
  role: string;
  content: string;
}

export const aiService = {
  /** Effective AI configuration: DB settings override env. */
  async getConfig(): Promise<AiConfig & { temperature: number; maxTokens: number; enabled: number; persona: string | null }> {
    const s = await settingsService.getInternal();
    const apiKey = s.ai_api_key || config.groqApiKey;
    return {
      provider: s.ai_provider || config.aiProvider,
      model: s.ai_model || config.aiModel,
      baseUrl: s.ai_base_url || config.aiBaseUrl,
      apiKey,
      available: Boolean(apiKey),
      temperature: Number(s.ai_temperature) || 0.5,
      maxTokens: Number(s.ai_max_tokens) || 900,
      enabled: s.ai_enabled,
      persona: s.ai_persona,
    };
  },

  async ask(question: string, history: ChatTurn[] = [], opts: { language?: string } = {}): Promise<AiResult> {
    const cfg = await this.getConfig();
    if (!cfg.apiKey) {
      throw new ApiError(
        503,
        "AI_NOT_CONFIGURED",
        "Live AI Help is not configured yet. An admin needs to add an API key in Settings → AI.",
      );
    }
    const q = str(question);
    if (!q) throw ApiError.badRequest("Question is required", "QUESTION_REQUIRED");
    if (q.length > 2000) throw ApiError.badRequest("Question is too long (max 2000 chars)", "QUESTION_TOO_LONG");

    const system = await aiKnowledgeService.buildSystemPrompt(cfg.persona);
    const messages: AiMessage[] = [
      system,
      ...history.slice(-MAX_CONTEXT_MESSAGES).map((t) => ({
        role: (["user", "assistant"].includes(t.role) ? t.role : "user") as "user" | "assistant",
        content: String(t.content).slice(0, 2000),
      })),
      { role: "user", content: q },
    ];

    // Language directive (original contract: appended to the user turn).
    const langNote = LANG_NOTE[opts.language || "en"] || "Answer in the same language the user used.";
    messages[messages.length - 1] = { role: "user", content: `${q}\n\n[System note: ${langNote}]` };

    const url = `${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`;
    const payload = JSON.stringify({
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_completion_tokens: cfg.maxTokens,
      top_p: 0.9,
      // Ask the provider to keep reasoning out of the answer where it supports
      // the hint. This is a hint only — `sanitizeAnswer()` is the guarantee.
      stream: false,
    });

    // One retry on a transient failure (network error, 5xx, provider 429).
    // Never retry a 4xx: a bad key or an invalid model will fail identically and
    // retrying only doubles the latency of an error the admin must see.
    let res: Response | null = null;
    let lastError: ApiError | null = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
          body: payload,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if ((err as Error).name === "AbortError") {
          lastError = new ApiError(504, "AI_TIMEOUT", "The AI provider took too long to respond — please try again.");
        } else {
          logger.error("ai: provider request failed", { attempt, err: String((err as Error)?.message ?? err) });
          lastError = new ApiError(502, "AI_UPSTREAM_ERROR", "The AI provider could not be reached. Please try again later.");
        }
        if (attempt === 1) {
          await sleep(400);
          continue;
        }
        throw lastError;
      }
      clearTimeout(timer);

      if (res.ok) break;

      const text = await res.text().catch(() => "");
      logger.error("ai: provider returned error", { attempt, status: res.status, body: text.slice(0, 300) });
      if (res.status === 401 || res.status === 403) {
        throw new ApiError(503, "AI_NOT_CONFIGURED", "The AI API key is invalid or has no access. An admin should update Settings → AI.");
      }
      if (res.status === 429) {
        lastError = new ApiError(429, "AI_RATE_LIMITED", "The AI provider is rate-limiting us — please wait a moment and retry.");
        if (attempt === 1) {
          await sleep(700);
          continue;
        }
        throw lastError;
      }
      if (res.status >= 500) {
        lastError = new ApiError(502, "AI_UPSTREAM_ERROR", "The AI provider returned an error. Please try again later.");
        if (attempt === 1) {
          await sleep(400);
          continue;
        }
        throw lastError;
      }
      throw new ApiError(502, "AI_UPSTREAM_ERROR", "The AI provider returned an error. Please try again later.");
    }

    if (!res || !res.ok) throw lastError ?? new ApiError(502, "AI_UPSTREAM_ERROR", "The AI provider returned an error.");

    const data = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { total_tokens?: number; completion_tokens?: number; prompt_tokens?: number };
      model?: string;
    } | null;

    // `extractAnswer` reads ONLY `message.content`. Providers that return the
    // chain of thought in a sibling `reasoning` / `reasoning_content` field are
    // ignored by construction, so that text can never be forwarded.
    const rawAnswer = extractAnswer(data?.choices?.[0]);
    // Reasoning models can also inline it as <think>…</think> inside content.
    const sanitized = sanitizeAnswer(rawAnswer);
    if (sanitized.hadReasoning) {
      logger.warn("ai: stripped internal reasoning from the model answer", {
        model: data?.model || cfg.model,
        removedChars: sanitized.removedChars,
      });
    }
    const content = sanitized.text.slice(0, MAX_ANSWER_CHARS);
    if (!content) {
      throw new ApiError(502, "AI_EMPTY_RESPONSE", "The AI returned an empty answer. Please try rephrasing your question.");
    }
    const tokens = data?.usage?.total_tokens ?? data?.usage?.completion_tokens ?? null;
    return {
      answer: content,
      model: data?.model || cfg.model,
      tokens,
      usage: data?.usage ?? null,
      reasoningChars: sanitized.removedChars,
    };
  },

  /** Preview the knowledge base an admin would feed the model (no live call). */
  async knowledgePreview(): Promise<{ prompt: string; productCount: number; model: string }> {
    const cfg = await this.getConfig();
    const preview = await aiKnowledgeService.knowledgePreview(cfg.persona);
    return { ...preview, model: cfg.model };
  },

  // ---------------------- original-contract endpoints ----------------------

  /** GET /api/ai/config — safe, public config for the widget. */
  async publicConfig(): Promise<{ success: boolean; enabled: boolean; model: string; provider: string; site_name: string | null; prompts: string[] }> {
    const s = await loadSettings();
    const cfg = await this.getConfig();
    return {
      success: true,
      enabled: Boolean(s.ai_enabled) && Boolean(cfg.apiKey),
      model: s.ai_model || config.aiModel,
      provider: s.ai_provider || config.aiProvider,
      site_name: s.site_name,
      prompts: parsePrompts(s.ai_prompts),
    };
  },

  /** POST /api/ai/chat — the Live AI Help popup (persists conversation). */
  async chat(
    body: { message?: unknown; conversation_id?: unknown; language?: unknown; user_id?: unknown },
  ): Promise<{ success: boolean; conversation_id: string; reply: string; links: { label: string; path: string; title: string }[]; model: string; usage: unknown }> {
    const cfg = await this.getConfig();
    const s = await loadSettings();
    if (!s.ai_enabled) {
      throw new ApiError(503, "AI_DISABLED", "🤖 The AI assistant is currently disabled. Please use Live Messaging to reach a human.");
    }
    if (!cfg.apiKey) {
      throw new ApiError(503, "AI_NOT_CONFIGURED", "🔑 The AI assistant is not configured yet. An admin must add the Groq API key in Admin Panel → AI Assistant. Meanwhile, please use Live Messaging to reach a human.");
    }
    const message = (str(body.message) ?? "").trim();
    if (!message) throw ApiError.badRequest("❌ Message cannot be empty.", "MESSAGE_REQUIRED");
    if (message.length > 4000) throw ApiError.badRequest("❌ Message too long.", "MESSAGE_TOO_LONG");

    const conversationId = str(body.conversation_id) || randomId();
    const language = str(body.language) || "en";
    const userId = str(body.user_id) || null;

    // Rebuild recent history for this conversation (bounded, ascending).
    const historyRows = await aiMessageRepo.history(conversationId, 12);
    const history: ChatTurn[] = historyRows.map((h) => ({
      role: h.role === "assistant" ? "assistant" : "user",
      content: h.content,
    }));

    const result = await this.ask(message, history, { language });

    // Persist both turns (best-effort) and prune old conversations. Only the
    // sanitized answer is stored, so the admin transcript can never re-expose
    // reasoning that was stripped on the way out.
    try {
      await aiMessageRepo.add(conversationId, userId, "user", message, cfg.model);
      await aiMessageRepo.add(conversationId, userId, "assistant", result.answer, cfg.model, {
        tokens: result.tokens,
        reasoningChars: result.reasoningChars ?? 0,
      });
      await aiMessageRepo.prune(300);
    } catch (err) {
      logger.warn("ai: history persistence failed", { err: String(err) });
    }

    return {
      success: true,
      conversation_id: conversationId,
      reply: result.answer,
      links: await extractLinks(result.answer),
      model: result.model,
      usage: result.tokens ? { total_tokens: result.tokens } : null,
    };
  },

  // ------------------------------- admin -------------------------------

  /** GET /api/ai/admin/config — full config (key masked) + model catalogue. */
  async adminConfig() {
    const s = await loadSettings();
    const cfg = await this.getConfig();
    return {
      success: true,
      settings: {
        ai_enabled: s.ai_enabled,
        ai_provider: s.ai_provider || config.aiProvider,
        ai_model: s.ai_model || config.aiModel,
        ai_base_url: s.ai_base_url || config.aiBaseUrl,
        ai_api_key: maskKey(cfg.apiKey),
        ai_temperature: s.ai_temperature,
        ai_max_tokens: s.ai_max_tokens,
        ai_persona: s.ai_persona,
        ai_prompts: s.ai_prompts,
      },
      models: MODEL_CHOICES,
      default_model: DEFAULT_MODEL,
    };
  },

  /** POST /api/ai/admin/config — save (masked key means "keep current"). */
  async adminSaveConfig(actor: SafeUser, body: Record<string, unknown>): Promise<{ success: boolean; message: string }> {
    const changes: Record<string, string | null> = {
      ai_enabled: body.ai_enabled ? "1" : "0",
      ai_provider: str(body.ai_provider) || config.aiProvider,
      ai_model: str(body.ai_model) || DEFAULT_MODEL,
      ai_base_url: str(body.ai_base_url) || config.aiBaseUrl,
      ai_temperature: String(body.ai_temperature ?? 0.5),
      ai_max_tokens: String(parseInt(String(body.ai_max_tokens ?? 900), 10) || 900),
      ai_persona: str(body.ai_persona) ?? null,
      ai_prompts: str(body.ai_prompts) ?? null,
    };
    // A masked key (contains a bullet) means "keep the existing one"; empty clears it.
    if (body.ai_api_key !== undefined) {
      const incoming = str(body.ai_api_key);
      if (incoming && !incoming.includes("•")) changes.ai_api_key = incoming;
      else if (incoming === "") changes.ai_api_key = "";
    }
    await settingsService.update(actor, changes);
    return { success: true, message: "✅ AI Assistant settings saved." };
  },

  /** POST /api/ai/admin/test — real round-trip against the provider. */
  async adminTest(body: { api_key?: unknown; model?: unknown; base_url?: unknown }): Promise<{ success: boolean; ok: boolean; ms?: number; model?: string; message: string; reply?: string }> {
    const cfg = await this.getConfig();
    const s = await loadSettings();
    const key = str(body.api_key) || "";
    const apiKey = key && !key.includes("•") ? key : cfg.apiKey;
    if (!apiKey) return { success: false, ok: false, message: "❌ No API key. Paste a Groq key or save one first." };
    const model = str(body.model) || cfg.model;
    const baseUrl = (str(body.base_url) || cfg.baseUrl).replace(/\/+$/, "");
    const started = Date.now();
    try {
      const r = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "You are testing a connection. Reply with exactly: OK" },
            { role: "user", content: "ping" },
          ],
          max_completion_tokens: 20,
          temperature: 0,
        }),
      });
      const ms = Date.now() - started;
      const text = await r.text();
      let data: { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string }; message?: string } | null = null;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      if (!r.ok) {
        return { success: false, ok: false, ms, model, message: `❌ Groq rejected the request (HTTP ${r.status}): ${data?.error?.message || data?.message || text.slice(0, 200)}` };
      }
      // Sanitized: the admin test panel renders this string, and a reasoning
      // model would otherwise dump its chain of thought into the admin UI.
      const reply = sanitizeAnswer(extractAnswer(data?.choices?.[0])).text.trim();
      return { success: true, ok: true, ms, model, message: `✅ Connection OK — ${model} replied “${reply}” in ${ms} ms.`, reply };
    } catch (e) {
      return { success: false, ok: false, message: `❌ Could not reach Groq: ${(e as Error).message}` };
    }
    void s;
  },

  /** GET /api/ai/admin/models — live catalogue, falling back to static. */
  async adminModels(): Promise<{ success: boolean; models: { id: string; label: string; note?: string }[]; source: string; note?: string }> {
    const cfg = await this.getConfig();
    if (!cfg.apiKey) {
      return { success: true, models: MODEL_CHOICES, source: "static", note: "Add a Groq API key to fetch the live catalogue." };
    }
    try {
      const r = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
      });
      const data = (await r.json()) as { data?: Array<{ id?: string }>; error?: { message?: string } };
      if (!r.ok) throw new Error(data?.error?.message || `HTTP ${r.status}`);
      const ids = (data?.data || []).map((m) => m.id).filter(Boolean) as string[];
      ids.sort();
      return { success: true, models: ids.map((id) => ({ id, label: id })), source: "groq" };
    } catch (e) {
      return { success: true, models: MODEL_CHOICES, source: "static", note: `Live fetch failed: ${(e as Error).message}` };
    }
  },

  /** GET /api/ai/admin/conversations — recent AI conversations + usage totals. */
  async adminConversations() {
    const conversations = await aiMessageRepo.recentConversations(50);
    const [totalTokens, totalTurns] = await Promise.all([aiMessageRepo.totalTokens(), aiMessageRepo.count()]);
    return {
      success: true,
      conversations: conversations.map((c) => ({
        conversation_id: c.conversation_id,
        turns: c.count,
        last_at: c.last_at,
        last_question: (c.preview || "").slice(0, 90),
      })),
      usage: { total_tokens: totalTokens, total_turns: totalTurns },
    };
  },

  /** GET /api/ai/admin/knowledge — what the assistant is currently told. */
  async adminKnowledge() {
    const cfg = await this.getConfig();
    const preview = await aiKnowledgeService.knowledgePreview(cfg.persona);
    return {
      success: true,
      preview: preview.prompt,
      characters: preview.prompt.length,
      approxTokens: Math.round(preview.prompt.length / 4),
      productCount: preview.productCount,
      model: cfg.model,
    };
  },
};
