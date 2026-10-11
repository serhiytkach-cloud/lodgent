import type { Clock, JobQueue, PaymentProvider } from '@lodgent/core';
import type { Database } from '@lodgent/db';
import type { Logger } from 'pino';
import type { CheckoutService } from './checkout';

/**
 * Stripe webhooks: verify the signature over the raw bytes, de-duplicate by event id, and hand the
 * work to background jobs so the endpoint answers quickly. Events only trigger re-reads; we never
 * trust their payload for state.
 */
export class PaymentWebhookService {
  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      payments: PaymentProvider;
      queue: JobQueue;
      checkout: CheckoutService;
      logger: Logger;
    },
  ) {}

  async handle(rawBody: Buffer, signature: string): Promise<{ received: boolean; duplicate?: boolean }> {
    const { db, payments, queue, checkout, logger } = this.deps;
    const event = payments.parseWebhook(rawBody, signature);
    const type = event.type === 'ignored' ? event.eventType : event.type;
    const fresh = await db.system(({ pms }) => pms.recordWebhookEvent('stripe', event.id, type));
    if (!fresh) return { received: true, duplicate: true };

    if (event.type === 'account.updated') {
      await queue.enqueue({
        type: 'payments.account-updated',
        payload: { accountId: event.accountId },
        dedupeKey: `stripe:${event.id}`,
      });
    } else if (event.type === 'payment_intent.updated' || event.type === 'setup_intent.updated') {
      const target = await checkout.handlePaymentEvent(event);
      if (target) {
        await queue.enqueue({
          type: 'checkout.finalize',
          payload: { orgId: target.orgId, bookingId: target.bookingId },
          dedupeKey: `stripe:${event.id}`,
        });
      } else {
        logger.info({ eventId: event.id, type }, 'payment event for no known booking');
      }
    }
    await db.system(({ pms }) => pms.markWebhookProcessed('stripe', event.id, this.deps.clock.now()));
    return { received: true };
  }
}
