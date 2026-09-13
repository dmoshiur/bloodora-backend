import type { Request, Response } from "express";
import { clientMessageId, liveChatService } from "../services/liveChat.service.js";
import { str } from "../utils/validate.js";

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
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write("retry: 4000\n\n");

  let cursor = 0;
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const send = (payload: unknown, event = "message") => {
    if (closed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* connection gone */
    }
  };

  const tick = async () => {
    if (closed) return;
    try {
      const { messages, closed: isClosed } = await liveChatService.pollSession(key, cursor);
      for (const m of messages) {
        cursor = Math.max(cursor, m.id);
        send({ type: "message", message: m });
      }
      if (isClosed) {
        send({ type: "closed" });
        finish();
        return;
      }
    } catch {
      /* transient DB hiccup — keep polling */
    }
  };

  const finish = () => {
    closed = true;
    if (timer) clearInterval(timer);
    try {
      res.end();
    } catch {
      /* already closed */
    }
  };

  send({ type: "connected", session_key: key, time: new Date().toISOString() }, "hello");
  void tick();
  timer = setInterval(() => void tick(), 2500);
  req.on("close", finish);
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
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write("retry: 4000\n\n");

  let cursor = new Date().toISOString();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const send = (payload: unknown, event = "message") => {
    if (closed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    } catch {
      /* connection gone */
    }
  };

  const tick = async () => {
    if (closed) return;
    try {
      const changes = await liveChatService.pollAdminActivity(cursor);
      for (const c of changes) {
        if (c.closed && !c.message) send({ type: "closed", session_key: c.session_key });
        else if (c.message) {
          send({ type: "message", session_key: c.session_key, visitor_name: c.visitor_name, message: c.message });
        }
      }
      cursor = new Date().toISOString();
    } catch {
      /* transient */
    }
  };

  const finish = () => {
    closed = true;
    if (timer) clearInterval(timer);
    try {
      res.end();
    } catch {
      /* already closed */
    }
  };

  send({ type: "connected", time: new Date().toISOString() }, "hello");
  void tick();
  timer = setInterval(() => void tick(), 2500);
  req.on("close", finish);
}
