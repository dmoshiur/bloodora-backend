import { get, all, run } from "../db/query.js";
import { randomId } from "../utils/errors.js";
import type { AiMessageRow } from "../types.js";

/** Live AI Help conversation history. */
export const aiMessageRepo = {
  /**
   * Persist one turn. Only the SANITIZED assistant text is ever stored — the
   * model's reasoning is dropped before it reaches the database, so it cannot
   * leak through the admin transcript view either.
   */
  async add(
    conversationId: string,
    userId: string | null,
    role: string,
    content: string,
    model: string | null,
    opts: { tokens?: number | null; reasoningChars?: number } = {},
  ): Promise<void> {
    await run(
      `INSERT INTO ai_messages (id, conversation_id, user_id, role, content, model, tokens, reasoning_chars)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomId(), conversationId, userId, role, content, model, opts.tokens ?? null, opts.reasoningChars ?? 0],
    );
  },

  /** Total tokens billed across stored turns (usage tracking). */
  async totalTokens(): Promise<number> {
    const row = await get<{ s: number | null }>(`SELECT COALESCE(SUM(tokens), 0) AS s FROM ai_messages`);
    return Number(row?.s ?? 0);
  },

  async count(): Promise<number> {
    const row = await get<{ n: number }>(`SELECT COUNT(*) AS n FROM ai_messages`);
    return row?.n ?? 0;
  },

  /** Conversation history (bounded) for context reconstruction. */
  async history(conversationId: string, limit = 20): Promise<AiMessageRow[]> {
    return all<AiMessageRow>(
      `SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?`,
      [conversationId, limit],
    );
  },

  /** Keep only the N most-recent conversations (best-effort). */
  async prune(keep = 300): Promise<void> {
    await run(
      `DELETE FROM ai_messages WHERE conversation_id NOT IN (
         SELECT conversation_id FROM ai_messages GROUP BY conversation_id ORDER BY MAX(created_at) DESC LIMIT ?
       )`,
      [keep],
    );
  },

  /** Recent conversations for the admin panel (aggregated). */
  async recentConversations(limit = 30): Promise<{ conversation_id: string; user_id: string | null; count: number; last_at: string; preview: string }[]> {
    return all(
      `SELECT conversation_id,
              MAX(user_id) AS user_id,
              COUNT(*) AS count,
              MAX(created_at) AS last_at,
              (SELECT content FROM ai_messages m2 WHERE m2.conversation_id = ai_messages.conversation_id ORDER BY created_at DESC LIMIT 1) AS preview
       FROM ai_messages
       GROUP BY conversation_id
       ORDER BY last_at DESC
       LIMIT ?`,
      [limit],
    );
  },
};
