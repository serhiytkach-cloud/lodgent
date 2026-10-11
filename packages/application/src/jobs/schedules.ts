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

export const SCHEDULES: Schedule[] = [];

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
