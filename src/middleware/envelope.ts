import type { NextFunction, Request, Response } from "express";

/**
 * One response shape, applied centrally.
 *
 *   success → { ok: true,  …the endpoint's own fields }
 *   failure → { ok: false, error: { code, message }, code, message, requestId }
 *              (built by `middleware/error.ts`)
 *
 * ============================== WHY THIS EXISTS =============================
 * This API grew one endpoint at a time and each author picked a reasonable shape:
 * `{success:true,…}`, `{settings:{…}}`, `{products:[…]}`, `{user:{…}}`. Every one
 * of them is fine in isolation and together they mean a client cannot answer the
 * only question that matters during an incident — "did this work?" — without
 * knowing which endpoint it is talking to.
 *
 * `ok` is that answer, and it is added HERE rather than at 180 call sites because
 * a convention that has to be remembered is a convention that gets forgotten. It
 * is purely additive: `success`, and every field the existing frontend and test
 * suites read, are untouched.
 *
 * Deliberately narrow:
 *   - only plain objects get the field (an array or a string body cannot carry
 *     one, and inventing a wrapper would break the endpoints that return them);
 *   - only when the handler did not set `ok` itself;
 *   - only for `res.json()`. Binary responses (`/uploads/:file`) and SSE streams
 *     write through `res.end()` / `res.write()` and are left alone — wrapping a
 *     PNG in a JSON envelope would be one way to break every image on the site.
 * ===========================================================================
 */

type JsonBody = Parameters<Response["json"]>[0];

function isPlainObject(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body) && !(body instanceof Buffer);
}

export function responseEnvelope(_req: Request, res: Response, next: NextFunction): void {
  const original = res.json.bind(res);

  res.json = ((body: JsonBody) => {
    if (isPlainObject(body) && body.ok === undefined) {
      // `ok` mirrors the status the handler already chose: a 201 is a success, a
      // 4xx/5xx written directly (not through the error handler) is not.
      return original({ ok: res.statusCode < 400, ...body });
    }
    return original(body);
  }) as Response["json"];

  next();
}
