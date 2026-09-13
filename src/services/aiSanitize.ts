/**
 * Sanitization of model output before it is ever shown to a user.
 *
 * Several models the admin can select are REASONING models (qwen3, gpt-oss,
 * kimi-k2-thinking…). Depending on the provider and the `reasoning_effort`
 * setting they emit their chain of thought either in a separate field
 * (`reasoning`, `reasoning_content`) or inline, wrapped in tags:
 *
 *     <think>The user asks about Anti-D. I should check…</think>
 *     Here is what you need to know…
 *
 * The inline form is the dangerous one: it arrives inside `message.content`, so
 * a naive `choices[0].message.content` passthrough publishes the model's private
 * reasoning — half-formed hypotheses, self-corrections, and anything the system
 * prompt told it — to the visitor. It also destroys the answer's usefulness,
 * because the widget renders whatever comes back.
 *
 * Rules implemented here:
 *  - every known reasoning block is removed, including an UNTERMINATED one (a
 *    truncated `max_tokens` response can end mid-thought with no closing tag —
 *    in that case everything after the opening tag is dropped);
 *  - provider reasoning FIELDS are never read, so they cannot leak;
 *  - a streaming filter keeps a small tail buffer so a reasoning tag split
 *    across two chunks (`…<th` + `ink>…`) is still caught;
 *  - if sanitizing removes everything, the caller reports an empty answer
 *    (502 AI_EMPTY_RESPONSE) rather than showing a blank bubble.
 */

/** Opening tags treated as the start of internal reasoning. */
const REASONING_TAGS = ["think", "thinking", "reasoning", "reasoning_content", "chain-of-thought", "cot", "analysis", "internal"];

const OPENERS = REASONING_TAGS.map((t) => `<${t}>`).join("|");
const CLOSERS = REASONING_TAGS.map((t) => `</${t}>`).join("|");

/** Complete `<think>…</think>` blocks (case-insensitive, dotall, non-greedy). */
const PAIRED_RE = new RegExp(`(?:${OPENERS})[\\s\\S]*?(?:${CLOSERS})`, "gi");
/** An opening tag with no closing tag: everything after it is reasoning. */
const UNTERMINATED_RE = new RegExp(`(?:${OPENERS})[\\s\\S]*$`, "i");
/** Leftover closing tags with no opener. */
const STRAY_CLOSE_RE = new RegExp(`(?:${CLOSERS})`, "gi");

export interface SanitizeResult {
  /** The user-facing answer. */
  text: string;
  /** How many characters of reasoning were removed (0 = nothing to strip). */
  removedChars: number;
  /** True when reasoning was present. */
  hadReasoning: boolean;
}

/** Strip reasoning from a complete model answer. */
export function sanitizeAnswer(raw: string | null | undefined): SanitizeResult {
  const input = String(raw ?? "");
  if (!input) return { text: "", removedChars: 0, hadReasoning: false };

  let out = input.replace(PAIRED_RE, "");
  out = out.replace(UNTERMINATED_RE, "");
  out = out.replace(STRAY_CLOSE_RE, "");
  // Removing a leading block usually leaves a blank line; tidy the edges only.
  out = out.replace(/^\s+/, "").replace(/\s+$/, "");

  return { text: out, removedChars: Math.max(0, input.length - out.length), hadReasoning: out.length !== input.trim().length };
}

/**
 * Pick the user-facing answer out of a provider response.
 *
 * `reasoning` / `reasoning_content` are deliberately NOT candidates: reading
 * them is how they leak. If a provider puts the answer only in a reasoning
 * field, we report an empty answer and the caller surfaces a friendly error.
 */
export function extractAnswer(choice: unknown): string {
  const message = (choice as { message?: { content?: unknown } } | undefined)?.message;
  const content = message?.content;
  if (typeof content === "string") return content;
  // Some providers return content as an array of parts.
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        const p = part as { type?: string; text?: unknown };
        return p?.type === "text" && typeof p.text === "string" ? p.text : "";
      })
      .join("");
  }
  return "";
}

/**
 * Incremental filter for a streamed response.
 *
 * `push(chunk)` returns only text that is safe to emit. When the tail of the
 * buffer could still turn out to be the beginning of a reasoning tag, that tail
 * is withheld until the next chunk disambiguates it — so `<think>` split
 * across SSE frames is never forwarded. `end()` flushes whatever is left.
 */
export function createStreamSanitizer() {
  let buffer = "";
  let inReasoning = false;

  const longestTag = Math.max(...REASONING_TAGS.map((t) => `</${t}>`.length));

  function emitSafe(): string {
    if (inReasoning) {
      // Look for a closing tag; everything up to it is dropped.
      const lower = buffer.toLowerCase();
      let cut = -1;
      let matched: string | null = null;
      for (const tag of REASONING_TAGS) {
        const idx = lower.indexOf(`</${tag}>`);
        if (idx !== -1 && (cut === -1 || idx < cut)) {
          cut = idx;
          matched = `</${tag}>`;
        }
      }
      if (cut === -1) {
        // Still inside reasoning. Keep a tail so a split closing tag is caught.
        buffer = buffer.slice(Math.max(0, buffer.length - longestTag));
        return "";
      }
      buffer = buffer.slice(cut + (matched?.length ?? 0));
      inReasoning = false;
      return emitSafe();
    }

    // Not in reasoning: drop any complete reasoning block, then check whether an
    // opening tag starts here.
    buffer = buffer.replace(PAIRED_RE, "");
    const lower = buffer.toLowerCase();
    for (const tag of REASONING_TAGS) {
      const idx = lower.indexOf(`<${tag}>`);
      if (idx !== -1) {
        const head = buffer.slice(0, idx);
        buffer = buffer.slice(idx + tag.length + 2);
        inReasoning = true;
        return head + emitSafe();
      }
    }
    // A partial opener may be sitting at the end of the buffer — withhold it.
    const hold = partialOpenerLength(buffer);
    if (hold > 0) {
      const out = buffer.slice(0, buffer.length - hold);
      buffer = buffer.slice(buffer.length - hold);
      return out;
    }
    const out = buffer;
    buffer = "";
    return out;
  }

  return {
    push(chunk: string): string {
      if (!chunk) return "";
      buffer += chunk;
      return emitSafe();
    },
    end(): string {
      if (inReasoning) {
        // Stream ended mid-reasoning: nothing left is user-facing.
        buffer = "";
        return "";
      }
      const out = buffer.replace(PAIRED_RE, "").replace(UNTERMINATED_RE, "");
      buffer = "";
      return out;
    },
    get pending(): number {
      return buffer.length;
    },
  };
}

/** Length of a trailing fragment that could still become `<tag>` (e.g. `<th`). */
function partialOpenerLength(text: string): number {
  const maxLen = Math.min(text.length, longestOpenerLength());
  for (let len = maxLen; len > 0; len -= 1) {
    const tail = text.slice(text.length - len).toLowerCase();
    if (!tail.startsWith("<")) continue;
    if (REASONING_TAGS.some((t) => `<${t}>`.startsWith(tail))) return len;
  }
  return 0;
}

function longestOpenerLength(): number {
  return Math.max(...REASONING_TAGS.map((t) => `<${t}>`.length));
}
