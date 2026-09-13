import type { Request, Response } from "express";
import { config } from "../config/env.js";
import { logger } from "./logger.js";

/**
 * Server-Sent Events helper.
 *
 * Three endpoints stream (activity feed, visitor chat, admin chat) and all three
 * previously repeated the same header block, `closed` flag, `finish()` and
 * `setInterval` bookkeeping. Consolidating them matters for more than tidiness:
 *
 * **A serverless function cannot hold a socket open indefinitely.** The platform
 * kills the invocation at `maxDuration` (10 s on Vercel Hobby). Without our own
 * deadline the stream was terminated mid-write, which the browser sees as a
 * truncated/failed response rather than a clean end — and the caller cannot tell
 * "no new events" apart from "the backend died". `SSE_MAX_MS` (default 9 s) ends
 * the stream *just before* that happens, so the client always observes a normal
 * close and can reconnect or fall back to polling, which the frontend already
 * does.
 *
 * Every timer created here is `unref()`'d: a stream must never be the thing that
 * keeps a frozen serverless instance alive, or that blocks `process.exit()` in
 * local dev.
 */
export interface SseStream {
  /** True once the stream has ended (client gone, lifetime reached, or `finish`). */
  readonly closed: boolean;
  /** Write one event. No-op after close; auto-finishes if the socket is gone. */
  write(payload: unknown, event?: string): void;
  /** Write a raw line (e.g. an SSE comment keep-alive). */
  raw(line: string): void;
  /** End the stream. Idempotent — safe to call from several paths. */
  finish(reason?: string): void;
  /** Register cleanup that runs exactly once, when the stream ends. */
  onClose(cb: () => void): void;
}

export function openSse(req: Request, res: Response, opts: { retryMs?: number; label: string }): SseStream {
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Proxies buffer by default, which would hold events until the stream closed
    // and defeat the purpose entirely.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write(`retry: ${opts.retryMs ?? 5000}\n\n`);

  let closed = false;
  const cleanups: Array<() => void> = [];

  const finish = (reason?: string) => {
    if (closed) return;
    closed = true;
    for (const cb of cleanups.splice(0)) {
      try {
        cb();
      } catch {
        /* cleanup must not mask the close */
      }
    }
    try {
      res.end();
    } catch {
      /* socket already gone */
    }
    logger.debug("sse: stream ended", { label: opts.label, reason: reason ?? "unspecified" });
  };

  const stream: SseStream = {
    get closed() {
      return closed;
    },
    write(payload: unknown, event = "message") {
      if (closed) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch {
        finish("write failed");
      }
    },
    raw(line: string) {
      if (closed) return;
      try {
        res.write(line);
      } catch {
        finish("write failed");
      }
    },
    finish,
    onClose(cb) {
      if (closed) cb();
      else cleanups.push(cb);
    },
  };

  // End ourselves before the platform does.
  if (config.sseMaxMs > 0) {
    const lifetime = setTimeout(() => finish("max stream lifetime reached"), config.sseMaxMs);
    lifetime.unref?.();
    stream.onClose(() => clearTimeout(lifetime));
  }

  req.on("close", () => finish("client disconnected"));
  res.on("error", () => finish("response error"));
  return stream;
}

/**
 * Drive `tick` on an interval for the life of the stream, then stop.
 *
 * The interval is registered as stream cleanup, so it dies on every close path —
 * client disconnect, lifetime reached, or an explicit `finish()` — and a closed
 * socket is never polled again.
 */
export function pollSse(stream: SseStream, intervalMs: number, tick: () => Promise<void> | void): void {
  if (stream.closed) return;
  const run = () => {
    if (stream.closed) return;
    void Promise.resolve()
      .then(tick)
      .catch(() => {
        /* a transient DB/network blip must not kill the stream */
      });
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  stream.onClose(() => clearInterval(timer));
}
