import type { Request, Response } from "express";
import { clientMessageId, liveChatService } from "../services/liveChat.service.js";
import { str } from "../utils/validate.js";
import { openSse, pollSse } from "../utils/sse.js";

// ---------- visitor side ----------

/** POST /api/support/session — start or resume a conversation. */
export async function startSession(req: Request, res: Response): Promise<void> {
  const out = await liveChatService.startSession({
    key: str(req.body.session_key),
    name: str(req.body.name),
    user: req.user ?? null,
    lang: req.lang,
  });
  res.json(out);
}

/** GET /api/support/messages?session=&after=<rowid> — polling fetch. */
export async function fetchMessages(req: Request, res: Response): Promise<void> {
  const session = str(req.query.session);
  const after = Number(req.query.after) > 0 ? Number(req.query.after) : null;
  const out = await liveChatService.messages(str(req.query.session) ?? "", after);
  res.json(out);
}

/**
 * POST /api/support/messages — visitor sends a message.
 *
 * Body: `{ session_key, body, client_message_id? }`. `client_message_id` is the
 * idempotency key: send the same one twice (retry, reconnect replay, double
 * click) and the second call returns the stored message with `duplicate: true`
 * instead of creating a second row.
 */
export async function sendMessage(req: Request, res: Response): Promise<void> {
  const out = await liveChatService.send({
    key: str(req.body.session_key),
    name: str(req.body.name),
    user: req.user ?? null,
    body: str(req.body.body) || str(req.body.message),
    clientMessageId: clientMessageId((req.body ?? {}) as Record<string, unknown>),
    lang: req.lang,
  });
  res.json(out);
}

/**
 * GET /api/support/stream?session= — visitor SSE channel.
 * Serverless-safe: the connection polls the DB for new rowids; no shared state.
 */
export function streamSession(req: Request, res: Response): void {
  const key = str(req.query.session);
  if (!key) {
    res.status(400).end();
    return;
  }
  // Headers, the close flag, the lifetime cap and the interval teardown all live
  // in openSse/pollSse now — see src/utils/sse.ts for why a serverless stream must
  // end itself before the platform's maxDuration does.
  const stream = openSse(req, res, { retryMs: 4000, label: "support:visitor" });
  let cursor = 0;

  const tick = async () => {
    const { messages, closed: isClosed } = await liveChatService.pollSession(key, cursor);
    for (const m of messages) {
      cursor = Math.max(cursor, m.id);
      stream.write({ type: "message", message: m });
    }
    if (isClosed) {
      stream.write({ type: "closed" });
      stream.finish("session closed");
    }
  };

  stream.write({ type: "connected", session_key: key, time: new Date().toISOString() }, "hello");
  pollSse(stream, 2500, tick);
}

// ---------- admin side ----------

/** GET /api/support/admin/sessions — inbox. */
export async function adminSessions(req: Request, res: Response): Promise<void> {
  res.json(await liveChatService.adminSessions());
}

/** GET /api/support/admin/sessions/:key/messages */
export async function adminMessages(req: Request, res: Response): Promise<void> {
  res.json(await liveChatService.adminMessages(req.params.key));
}

/** POST /api/support/admin/sessions/:key/reply (idempotent via client_message_id) */
export async function adminReply(req: Request, res: Response): Promise<void> {
  if (!req.user) throw new Error("LOGIN_REQUIRED");
  const out = await liveChatService.adminReply(req.user, req.params.key, str(req.body.body) ?? "", {
    clientMessageId: clientMessageId((req.body ?? {}) as Record<string, unknown>),
    lang: req.lang,
  });
  res.json(out);
}

/** POST /api/support/admin/sessions/:key/close */
export async function adminClose(req: Request, res: Response): Promise<void> {
  res.json(await liveChatService.adminClose(req.params.key));
}

/**
 * GET /api/support/admin/stream — admin SSE feed of every conversation.
 * Polls the DB for sessions whose last_message_at moved past the cursor.
 */
export function adminStream(req: Request, res: Response): void {
  const stream = openSse(req, res, { retryMs: 4000, label: "support:admin" });
  let cursor = new Date().toISOString();

  const tick = async () => {
    const changes = await liveChatService.pollAdminActivity(cursor);
    for (const c of changes) {
      if (c.closed && !c.message) stream.write({ type: "closed", session_key: c.session_key });
      else if (c.message) {
        stream.write({ type: "message", session_key: c.session_key, visitor_name: c.visitor_name, message: c.message });
      }
    }
    cursor = new Date().toISOString();
  };

  stream.write({ type: "connected", time: new Date().toISOString() }, "hello");
  pollSse(stream, 2500, tick);
}
