import type { Request, Response, NextFunction, RequestHandler } from "express";

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Express 4 does not forward rejected promises from async route handlers —
 * an unhandled rejection crashes the request with an empty 500. Wrap every
 * async handler with ah() so rejections reach the central error handler.
 */
export function ah(handler: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
