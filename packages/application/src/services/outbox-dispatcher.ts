import type { Clock, JobQueue, Mailer } from '@lodgent/core';
import type { Database } from '@lodgent/db';
import type { Logger } from 'pino';
import { z } from 'zod';
import { renderEmail } from '../email/templates';
import { scrubEmails } from '../logging';

const EmailPayload = z.object({ to: z.email(), template: z.string(), data: z.unknown() });
const JobPayload = z.object({
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  dedupeKey: z.string().optional(),
});

/** Topics whose payload may contain secrets or PII and is scrubbed once delivered. */
const SCRUB_AFTER_DISPATCH = new Set(['email.send']);

/**
 * Delivers outbox messages written by tenant transactions. Rows are claimed with
 * `FOR UPDATE SKIP LOCKED`, so several workers can run side by side. Failures back off exponentially.
 */
export class OutboxDispatcher {
  constructor(
    private readonly deps: { db: Database; mailer: Mailer; queue: JobQueue; clock: Clock; logger: Logger },
  ) {}

  async dispatchBatch(limit = 20): Promise<number> {
    const { db, clock, logger } = this.deps;
    return db.system(async ({ outbox }) => {
      const messages = await outbox.claimPending(clock.now(), limit);
      for (const message of messages) {
        try {
          await this.deliver(message.topic, message.payload);
          await outbox.markDispatched(message.id, clock.now());
          if (SCRUB_AFTER_DISPATCH.has(message.topic)) await outbox.scrub(message.id);
        } catch (error) {
          const attempts = message.attempts + 1;
          const backoffMs = Math.min(2 ** attempts * 1000, 60 * 60 * 1000);
          logger.warn(
            { err: error, outboxId: message.id, topic: message.topic, attempts },
            'outbox delivery failed',
          );
          // Provider errors can quote the recipient's address; never store it with the error.
          await outbox.markFailed(
            message.id,
            scrubEmails(String(error)),
            new Date(clock.now().getTime() + backoffMs),
          );
        }
      }
      return messages.length;
    });
  }

  private async deliver(topic: string, payload: Record<string, unknown>): Promise<void> {
    switch (topic) {
      case 'email.send': {
        const email = EmailPayload.parse(payload);
        const rendered = renderEmail(email.template, email.data);
        await this.deps.mailer.send({ to: email.to, ...rendered });
        return;
      }
      case 'job.enqueue': {
        const job = JobPayload.parse(payload);
        await this.deps.queue.enqueue(job);
        return;
      }
      default:
        throw new Error(`Unknown outbox topic: ${topic}`);
    }
  }
}
