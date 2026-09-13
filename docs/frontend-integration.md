# Frontend integration contract

Everything a client of this API needs in order to fail *gracefully* instead of
hanging. Written for the BloodOra frontend (`dmoshiur/lspk`), but the contract
applies to any caller — mobile app, cron job, another service.

A ready-to-apply patch for the frontend lives at
[`lspk-frontend.patch`](./lspk-frontend.patch); see
[Applying the frontend patch](#applying-the-frontend-patch) at the end.

---

## 1. The response envelope

Every response this API produces is JSON — including every failure, including the
outer failsafe that fires when a handler ignores all of its own deadlines.

**Success**

```json
{ "ok": true, "success": true, "...": "the route's own fields" }
```

**Failure**

```json
{
  "ok": false,
  "success": false,
  "error": {
    "code": "DB_UNAVAILABLE",
    "message": "Database service is temporarily unavailable. Please try again.",
    "retryable": true
  },
  "code": "DB_UNAVAILABLE",
  "message": "Database service is temporarily unavailable. Please try again.",
  "retryable": true,
  "requestId": "467a6367a5dcec95"
}
```

Read it like this:

| Field | Meaning | How to use it |
| --- | --- | --- |
| `ok` | `true` for any status < 400 | The single branch to use. Added centrally, so it is present even on routes that predate it. |
| `success` | legacy alias of `ok` | Kept because existing frontend code checks it. Do not write new code against it. |
| `code` | stable machine code | **Branch on this.** Messages are localized (en/bn/ar) and written for humans. |
| `message` | localized, safe to display | Never contains a host, URL, token, SQL statement or stack. |
| `error` | the same three fields nested | Some clients read the nested form; both are always present. |
| `retryable` | can asking again possibly succeed? | `false` means an operator must change something — do not loop. |
| `requestId` | correlation ID | Also sent as the `X-Request-Id` response header. Show it in a support message: it maps to exactly one line in the backend log. |

`Retry-After` (seconds) is sent on every retryable 503/504 and on 429. Honour it
instead of retrying immediately; the value comes from the backend's circuit
breaker, i.e. from how long it intends to keep failing fast.

### Request IDs

Send `X-Request-Id` (or let Vercel's `x-vercel-id` be picked up) and the same ID
is echoed back, reused in logs and included in error bodies. IDs from clients are
sanitized to `[A-Za-z0-9._-]`, max 128 characters, and generated when absent.
Every `[API] request` / `[API] response` log line carries it, so one user's
complaint can be traced end to end without a timestamp hunt.

---

## 2. The health probe

```bash
curl -s https://YOUR_BACKEND/api/health
```

```json
{
  "ok": true, "success": true, "status": "ok",
  "service": "bloodora-backend", "label": "BloodOra API", "version": "2.0.0",
  "database": "connected", "db": "ok", "dbMs": 38,
  "breaker": "closed", "env": "production",
  "budgetMs": 9500, "answerByMs": 8000,
  "requestId": "…", "time": "…", "uptime": 12.3
}
```

Branch on **`ok`**. The rest tells you *why*:

| Field | Values | What it means |
| --- | --- | --- |
| `database` / `db` | `connected` / `unavailable`, `ok` / `error` | The dependency verdict (`db` is the legacy alias). |
| `reason` | `timeout`, `unreachable`, `server_error`, `rate_limited`, `auth_rejected`, `not_configured`, `closed`, `unknown` | Only present on failure. `auth_rejected` = the Turso token is wrong; `not_configured` = the URL is missing; `timeout` = the host never answered. |
| `breaker` | `closed`, `open`, `half-open` | `open` means data routes are failing fast without touching the database. The probe itself bypasses the breaker, so it keeps telling the truth while open — and a successful probe is what closes it again. |
| `dbMs` | ms | The probe's own round-trip. Compare with `answerByMs` to see how much of the invocation is left. |
| `budgetMs` / `answerByMs` | ms | The function budget, and the point by which any request will have answered. Use `answerByMs` to size your own client timeout (next section). |

The probe is exempt from sessions, bootstrap and language resolution, and its own
`SELECT 1` is bounded at 1.5 s: a hung database yields a 503 in ~1.5 s, never an
endless wait. `/` and `/health` answer without touching the database at all, so
"the function is dead" stays distinguishable from "the function is up and its
database is not".

---

## 3. Budget arithmetic: why your client must time out too

Both this API and the frontend that calls it run as Vercel functions on a 10 s
clock, and the frontend *waits* for the API before it can render:

```
browser ──▶ frontend function (maxDuration 10 s)
                 └──▶ POST /api/ai/chat (maxDuration 10 s)
                            └──▶ Groq
```

The backend now answers by `answerByMs`:

```
answerByMs = FUNCTION_MAX_DURATION_MS − RESPONSE_RESERVE_MS − UPSTREAM_RESERVE_MS
           = 10000 − 500 − 1500 = 8000
```

`UPSTREAM_RESERVE_MS` is held back *for the caller*. That is the whole point: an
inner hop that spends its entire budget leaves the outer hop nothing to render and
flush with, so the platform kills it and answers the browser with an **HTML**
`504 FUNCTION_INVOCATION_TIMEOUT` — a body no `res.json()` can parse. That single
fact is how a healthy-looking backend ("`[BOOT] database: ready`", no failing
request in the log, because the request *succeeded*) still reached users as a
"server crashed" page with a spinner that never stopped.

Rules for a caller:

1. **Always time out.** A `fetch` with no deadline is not a slow request, it is
   your function being killed. Use `AbortController` so the socket is released.
2. **Size the timeout from `answerByMs`, not from your own limit.** `9 s` works
   against the default: you will normally receive the backend's own JSON error
   (with `code` and `requestId`) rather than inventing one. Never exceed your own
   `maxDuration` minus ~1 s of render time.
3. **One deadline across all retries.** Per-attempt timeouts multiplied by a retry
   count is how the outer function dies mid-retry. Check the remaining budget
   before starting an attempt, and do not start one that cannot finish.
4. **Retry only what is retryable.** `retryable: false` (e.g. `DB_AUTH_FAILED`)
   cannot be fixed by asking again; honour `Retry-After` when it is present.
5. **Always clear the loading state**, in a `finally`, and guard `res.json()` —
   a platform HTML error page must degrade to a message, not a stuck spinner.

### Codes worth branching on

| `code` | Status | `retryable` | Client behaviour |
| --- | --- | --- | --- |
| `DB_TIMEOUT`, `DB_UNAVAILABLE`, `DB_NOT_READY` | 503 | `true` | Back off by `Retry-After`, offer Retry. |
| `DB_AUTH_FAILED`, `DB_NOT_CONFIGURED` | 503 | **`false`** | Say "temporarily unavailable"; do **not** loop. An operator must fix credentials/config. |
| `REQUEST_TIMEOUT`, `FUNCTION_BUDGET_EXHAUSTED` | 504 | `true` | Retry once, ideally later. |
| `AI_TIMEOUT`, `AI_UPSTREAM_ERROR` | 502/504 | `true` | Retry once; the AI provider was slow, not the database. |
| `RATE_LIMITED`, `RESET_THROTTLED` | 429 | `true` | Honour `Retry-After`. |
| `UNAUTHENTICATED`, `SESSION_INVALID`, `LOGIN_REQUIRED` | 401 | — | Re-authenticate. **Not** a database problem — do not show "server error". |
| `EMAIL_TAKEN`, `OUT_OF_STOCK`, `STOCK_CHANGED`, … | 400/409 | — | Actionable validation state; render the message. |
| `INTERNAL` | 500 | — | A genuine application bug. Details are in the server log under `requestId`. |

The full table lives in the README under **Error codes**.

---

## 4. Applying the frontend patch

[`lspk-frontend.patch`](./lspk-frontend.patch) implements rules 1–5 in
`dmoshiur/lspk`. It was generated from a real checkout and verified to apply
cleanly to commit `886d056`:

```bash
cd lspk
git apply --check docs/lspk-frontend.patch   # from this repo
git apply       docs/lspk-frontend.patch
```

What it changes:

**`src/api.js`**
- `REQUEST_TIMEOUT_MS` (default 9 000, override with `BACKEND_TIMEOUT_MS`), used
  by every request through an `AbortController` — the socket is actually released,
  not just abandoned. A timeout surfaces as `ApiError{code:"BACKEND_TIMEOUT",
  status:0, retryable:true}`; an unreachable host as `BACKEND_UNREACHABLE`.
- `ApiError` lifts `code`, `retryable`, `requestId`, `retryAfterMs` out of the
  backend envelope (or out of a locally-constructed failure), so callers branch on
  `err.code` without knowing where the error came from.
- Failure detection accepts `ok === false` as well as `success === false`, and
  reads `Retry-After` and `X-Request-Id` from the headers.
- `apiPost()` takes an optional `timeoutMs`, so a caller with less budget left can
  say so instead of always waiting the full default.
- `proxyEventStream()` bounds the *connect* only — an SSE stream must stay open
  until the backend ends it (it self-terminates inside `SSE_MAX_MS`, clamped to the
  same caller-safe budget).

**`src/routes/ai.js`**
- One shared deadline (`AI_PROXY_BUDGET_MS`, default 9 000 = our 10 s limit minus
  `RENDER_RESERVE_MS`) across all attempts; no attempt starts unless it can finish.
- Retries on 429/5xx/network, never when the backend said `retryable: false`.
- The response forwards `code`, `requestId` and `retryable`, and reports 504 (not
  502) when the budget ran out before any answer arrived — a 504 is retryable, a
  502 reads as broken.

**`views/partials/footer.ejs`** (the Live AI Help widget)
- Failures render through one `aiError()` helper that offers a **Retry button only
  when retrying could succeed**, re-sending the last message through the existing
  path (a real action, not a decorative one), and shows the `requestId` as a small
  monospace reference. The typing indicator and input are still cleared in the
  existing `finally`, so the widget can never be left spinning.

### Verification

The patch was exercised against a stub backend that hangs, returns
`503 DB_AUTH_FAILED retryable:false`, and returns `503 DB_UNAVAILABLE
retryable:true` with `Retry-After: 2` — 14 checks, all passing:

```
PASS  a hanging backend is abandoned at the client deadline            605ms
PASS  ...and says so with a retryable, parseable error                 BACKEND_TIMEOUT
PASS  an operator failure carries its stable code                      DB_AUTH_FAILED
PASS  ...is marked NOT retryable                                       false
PASS  ...and carries the requestId for support                         abc123def456
PASS  a transient failure IS retryable, with Retry-After parsed        retryAfterMs=2000
PASS  the proxy answers JSON inside its own budget while the backend hangs   502 in 1518ms
PASS  ...it did not stack three 9s attempts                            backend attempts=1
PASS  ...and the body is the machine-readable envelope                 {ok:false,retryable:true}
PASS  an operator failure is not retried (one attempt only)            backend attempts=1 in 6ms
PASS  ...the browser is told retrying cannot help                      retryable:false
PASS  ...and the requestId reaches the browser                         abc123def456
PASS  a transient failure is retried (attempts > 1)                    backend attempts=2
PASS  ...without outliving the budget                                  609ms
```

Before the patch the first of those had no answer at all: the call waited
indefinitely, the frontend function was killed at 10 s, and the browser received
Vercel's HTML 504.

### Frontend deployment settings

```jsonc
// vercel.json — make the limit explicit rather than inherited
{ "functions": { "server.js": { "maxDuration": 10 } } }
```

If you raise it, raise `AI_PROXY_BUDGET_MS` with it — and remember the browser
waits on the **sum** of both hops. The backend's own `maxDuration` stays at 10
(`vercel.json`), mirrored by `FUNCTION_MAX_DURATION_MS`; the two must always
agree, which `npm run test:budget` enforces.
