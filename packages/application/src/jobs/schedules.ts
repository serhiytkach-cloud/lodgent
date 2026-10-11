import type { JobQueue } from '@lodgent/core';
import { SCHEDULES, type Schedule } from '@lodgent/shared';
import type { Logger } from 'pino';

/**
 * The schedule list lives in @lodgent/shared (pure data) so the CDK app can turn every entry into an
 * EventBridge Scheduler schedule that sends the job to SQS. Locally the worker's in-process
 * scheduler below enqueues them. Re-exported here for existing imports.
 */
export { SCHEDULES, type Schedule };

/** Enqueues due schedules. Dedupe keys make concurrent workers enqueue each slot only once. */
export class LocalScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastSlot = new Map<string, number>();

  constructor(
    private readonly queue: JobQueue,
    private readonly logger: Logger,
    private readonly schedules: readonly Schedule[] = SCHEDULES,
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
