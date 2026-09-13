const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

type Level = keyof typeof LEVELS;
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || "info"] ?? 20;

const SECRET_RE = /(secret|token|password|passwd|pass|authorization|api[_-]?key|cookie|session|jwt|signature)/i;

/** Recursively redact anything that looks like a credential before it hits the log. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") return (value as string).slice(0, 500);
  if (t === "number" || t === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (t === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_RE.test(k) && v !== undefined ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value).slice(0, 300);
}

class Logger {
  private log(level: Level, msg: string, fields?: Record<string, unknown>): void {
    if (LEVELS[level] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    });
    if (level === "error") process.stderr.write(line + "\n");
    else process.stdout.write(line + "\n");
  }
  debug(msg: string, fields?: Record<string, unknown>) { this.log("debug", msg, fields); }
  info(msg: string, fields?: Record<string, unknown>) { this.log("info", msg, fields); }
  warn(msg: string, fields?: Record<string, unknown>) { this.log("warn", msg, fields); }
  error(msg: string, fields?: Record<string, unknown>) { this.log("error", msg, fields); }
}

export const logger = new Logger();
