import { emailService } from "./email.service.js";
import { outboxRepo } from "../repos/outbox.repo.js";
import { tokenRepo } from "../repos/token.repo.js";
import { rateLimitRepo } from "../repos/rateLimit.repo.js";
import { notificationRepo } from "../repos/notification.repo.js";
import { auditRepo } from "../repos/audit.repo.js";
import { transactionRepo } from "../repos/transaction.repo.js";
import { activityRepo } from "../repos/activity.repo.js";
import { aiMessageRepo } from "../repos/aiMessage.repo.js";
import { logger } from "../utils/logger.js";
import { budgetExhausted } from "../utils/deadline.js";

/**
 * Housekeeping that a long-lived server would do on a timer.
 *
 * On a serverless deployment there is no timer: instances appear and disappear,
 * so nothing would ever run unless a request triggered it. Every task below is
 * therefore idempotent, bounded and safe to call on demand — from the admin
 * panel (`POST /api/admin/maintenance`) or from an external cron hitting that
 * same endpoint with a super-admin token.
 *
 * Each task is isolated: one failure is recorded and the rest still run, because
 * "the mail queue is stuck" must not stop expired reset tokens from being
 * purged.
 */

export interface TaskResult {
  task: string;
  ok: boolean;
  affected?: number;
  detail?: Record<string, unknown>;
  error?: string;
  ms: number;
}

async function task(name: string, fn: () => Promise<number | Record<string, unknown>>): Promise<TaskResult> {
  const started = Date.now();
  try {
    const out = await fn();
    if (typeof out === "number") return { task: name, ok: true, affected: out, ms: Date.now() - started };
    return { task: name, ok: true, detail: out, ms: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`maintenance: ${name} failed`, { err: message });
    return { task: name, ok: false, error: message, ms: Date.now() - started };
  }
}

/** The mail flush as a plain task body (shared by `flushMail` and `run`). */
async function flushMailRaw(limit: number): Promise<Record<string, unknown>> {
  return { ...(await emailService.flush(limit)) };
}

/** Time one more task may need; below this the sweep stops and reports. */
const MIN_TASK_BUDGET_MS = 400;

export const maintenanceService = {
  /** Retry everything still queued in the mail outbox. */
  async flushMail(limit = 20): Promise<TaskResult> {
    return task("mail.flush", () => flushMailRaw(limit));
  },

  /**
   * Full sweep: mail queue, expired tokens, stale rate-limit buckets and the
   * bounded history tables.
   */
  async run(opts: { flushMail?: boolean; mailLimit?: number } = {}): Promise<{
    success: boolean;
    tasks: TaskResult[];
    /** Task names never started because the invocation ran out of time. */
    skipped: string[];
    ms: number;
  }> {
    const started = Date.now();
    const tasks: TaskResult[] = [];

    // Each task is a bounded DB round trip, but seven of them plus a mail flush
    // run SEQUENTIALLY in one invocation. The sweep therefore stops as soon as the
    // budget runs low and reports what it did not reach: a partial sweep that
    // answers beats a complete one the platform kills at 10 s and never delivers.
    // Every task is idempotent, so the next run simply continues where this
    // stopped.
    const planned: Array<[string, () => Promise<number | Record<string, unknown>>]> = [];
    if (opts.flushMail !== false) {
      planned.push(["mail.flush", () => flushMailRaw(opts.mailLimit ?? 20)]);
    }
    planned.push(["tokens.purge", () => tokenRepo.purgeExpired()]);
    planned.push(["rate_limits.purge", () => rateLimitRepo.purge()]);
    planned.push(["notifications.prune", () => notificationRepo.prune()]);
    planned.push(["audit.prune", () => auditRepo.prune()]);
    planned.push(["transactions.prune", () => transactionRepo.prune()]);
    planned.push(["activity.prune", () => activityRepo.prune()]);
    planned.push(["ai_messages.prune", async () => {
      await aiMessageRepo.prune();
      return 0;
    }]);

    const skipped: string[] = [];
    for (const [name, fn] of planned) {
      if (budgetExhausted(MIN_TASK_BUDGET_MS)) {
        skipped.push(name);
        continue;
      }
      tasks.push(await task(name, fn));
    }

    const ms = Date.now() - started;
    logger.info("maintenance: sweep complete", {
      ms,
      failed: tasks.filter((t) => !t.ok).map((t) => t.task),
      skipped,
    });
    // A task skipped for lack of time is not a failure — `success` still reports
    // whether everything that DID run worked, and `skipped` names the rest.
    return { success: tasks.every((t) => t.ok), tasks, skipped, ms };
  },

  /** Outbox snapshot for the admin mail view. */
  async mailStatus(limit = 25, status?: string | null) {
    const [counts, rows] = await Promise.all([outboxRepo.counts(), outboxRepo.recent(limit, status)]);
    return { success: true, ...counts, recent: rows, max_attempts: 5 };
  },
};
