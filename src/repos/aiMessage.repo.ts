import { get, all, run } from "../db/query.js";
import { randomId } from "../utils/errors.js";
import type { AiMessageRow } from "../types.js";

/** Live AI Help conversation history. */
export const aiMessageRepo = {
  async add(conversationId: string, userId: string | null, role: string, content: string, model: string | null): Promise<void> {
    await run(
      `INSERT INTO ai_messages (id, conversation_id, user_id, role, content, model) VALUES (?, ?, ?, ?, ?, ?)`,
      [randomId(), conversationId, userId, role, content, model],
    );
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
