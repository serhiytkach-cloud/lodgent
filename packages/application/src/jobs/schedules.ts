import type { JobQueue } from '@lodgent/core';
import type { Logger } from 'pino';

/**
 * Recurring jobs. In AWS each entry becomes an EventBridge Scheduler schedule that sends the job to
 * SQS (see infra/lib/app-stack.ts, which imports this list). Locally the worker's in-process
 * scheduler enqueues them.
 */
export interface Schedule {
  name: string;
  /** Run every N minutes, aligned to the epoch. */
  everyMinutes: number;
  /** EventBridge `rate()` or `cron()` expression for AWS. */
  expression: string;
  job: { type: string; payload: Record<string, unknown> };
}

export const SCHEDULES: Schedule[] = [
  {
    name: 'pms-sync-all',
    everyMinutes: 360,
    expression: 'rate(6 hours)',
    job: { type: 'pms.sync-all', payload: {} },
  },
  {
    name: 'holds-expire',
    everyMinutes: 1,
    expression: 'rate(1 minute)',
    job: { type: 'holds.expire', payload: {} },
  },
  {
    name: 'checkout-reconcile',
    everyMinutes: 5,
    expression: 'rate(5 minutes)',
    job: { type: 'checkout.reconcile', payload: {} },
  },
  {
    name: 'privacy-retention',
    everyMinutes: 1440,
    expression: 'cron(30 3 * * ? *)',
    job: { type: 'privacy.retention', payload: {} },
  },
  {
    name: 'visibility-weekly',
    everyMinutes: 7 * 1440,
    expression: 'cron(15 4 ? * MON *)',
    job: { type: 'visibility.schedule-all', payload: {} },
  },
  {
    name: 'visibility-purge',
    everyMinutes: 1440,
    expression: 'cron(45 3 * * ? *)',
    job: { type: 'visibility.purge', payload: {} },
  },
  {
    // Invoices last month's pay-at-hotel fees (idempotent per period) and re-checks open invoices.
    name: 'billing-daily',
    everyMinutes: 1440,
    expression: 'cron(10 6 * * ? *)',
    job: { type: 'billing.daily', payload: {} },
  },
  {
    name: 'offers-cleanup',
    everyMinutes: 60,
    expression: 'rate(1 hour)',
    job: { type: 'offers.cleanup', payload: {} },
  },
];

/** Enqueues due schedules. Dedupe keys make concurrent workers enqueue each slot only once. */
export class LocalScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastSlot = new Map<string, number>();

  constructor(
    private readonly queue: JobQueue,
    private readonly logger: Logger,
    private readonly schedules: Schedule[] = SCHEDULES,
  ) {}

  async tick(now = new Date()): Promise<void> {
    for (const schedule of this.schedules) {
      const slot = Math.floor(now.getTime() / (schedule.everyMinutes * 60_000));
      if (this.lastSlot.get(schedule.name) === slot) continue;
      this.lastSlot.set(schedule.name, slot);
      try {
        await this.queue.enqueue({ ...schedule.job, dedupeKey: `schedule:${schedule.name}:${slot}` });
      } catch (error) {
        this.logger.warn({ err: error, schedule: schedule.name }, 'failed to enqueue scheduled job');
      }
    }
  }

  start(intervalMs = 15_000): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
