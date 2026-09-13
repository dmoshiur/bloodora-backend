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

export const maintenanceService = {
  /** Retry everything still queued in the mail outbox. */
  async flushMail(limit = 20): Promise<TaskResult> {
    return task("mail.flush", async () => {
      const out = await emailService.flush(limit);
      return { ...out };
    });
  },

  /**
   * Full sweep: mail queue, expired tokens, stale rate-limit buckets and the
   * bounded history tables.
   */
  async run(opts: { flushMail?: boolean; mailLimit?: number } = {}): Promise<{ success: boolean; tasks: TaskResult[]; ms: number }> {
    const started = Date.now();
    const tasks: TaskResult[] = [];

    if (opts.flushMail !== false) tasks.push(await this.flushMail(opts.mailLimit ?? 20));

    tasks.push(await task("tokens.purge", () => tokenRepo.purgeExpired()));
    tasks.push(await task("rate_limits.purge", () => rateLimitRepo.purge()));
    tasks.push(await task("notifications.prune", () => notificationRepo.prune()));
    tasks.push(await task("audit.prune", () => auditRepo.prune()));
    tasks.push(await task("transactions.prune", () => transactionRepo.prune()));
    tasks.push(await task("activity.prune", () => activityRepo.prune()));
    tasks.push(await task("ai_messages.prune", async () => {
      await aiMessageRepo.prune();
      return 0;
    }));

    const ms = Date.now() - started;
    logger.info("maintenance: sweep complete", {
      ms,
      failed: tasks.filter((t) => !t.ok).map((t) => t.task),
    });
    return { success: tasks.every((t) => t.ok), tasks, ms };
  },

  /** Outbox snapshot for the admin mail view. */
  async mailStatus(limit = 25, status?: string | null) {
    const [counts, rows] = await Promise.all([outboxRepo.counts(), outboxRepo.recent(limit, status)]);
    return { success: true, ...counts, recent: rows, max_attempts: 5 };
  },
};
