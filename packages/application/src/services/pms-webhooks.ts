import { timingSafeEqual } from 'node:crypto';
import { ApaleoWebhookEvent } from '@lodgent/apaleo';
import { type Clock, UnauthorizedError } from '@lodgent/core';
import type { Database } from '@lodgent/db';
import type { Logger } from 'pino';

/**
 * Apaleo webhooks carry no signature, so the endpoint URL contains a secret token, the payload is
 * treated as a hint only (we re-fetch the reservation from Apaleo with our own credentials), and
 * events are de-duplicated before a job is queued.
 */
export class PmsWebhookService {
  constructor(private readonly deps: { db: Database; clock: Clock; logger: Logger; webhookToken: string }) {}

  verifyToken(token: string): void {
    const a = Buffer.from(token);
    const b = Buffer.from(this.deps.webhookToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedError('Invalid webhook token');
  }

  async handleApaleo(token: string, body: unknown): Promise<{ accepted: boolean }> {
    this.verifyToken(token);
    const parsed = ApaleoWebhookEvent.safeParse(body);
    if (!parsed.success) return { accepted: false };
    const event = parsed.data;
    if (event.topic.toLowerCase() === 'system') return { accepted: true }; // health checks
    if (event.topic.toLowerCase() !== 'reservation' || !event.id || !event.accountId)
      return { accepted: false };

    const { db, clock, logger } = this.deps;
    const eventId = `${event.topic}:${event.type}:${event.id}:${event.timestamp ?? ''}`;
    return db.system(async ({ pms, outbox }) => {
      const fresh = await pms.recordWebhookEvent('apaleo', eventId, `${event.topic}/${event.type}`);
      if (!fresh) return { accepted: true };
      const connection = await pms.connectionByAccount('apaleo', event.accountId!);
      if (!connection) {
        logger.info({ accountId: event.accountId }, 'Apaleo webhook for an unknown account ignored');
        return { accepted: false };
      }
      await outbox.add(
        'job.enqueue',
        {
          type: 'pms.reservation-changed',
          payload: { orgId: connection.organizationId, pmsReservationId: event.id, event: event.type },
        },
        { organizationId: connection.organizationId },
      );
      await pms.markWebhookProcessed('apaleo', eventId, clock.now());
      return { accepted: true };
    });
  }
}
