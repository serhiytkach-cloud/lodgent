import type { Logger } from 'pino';
import { z } from 'zod';
import type { Container } from '../container';

export interface JobContext {
  logger: Logger;
  /** 1 on the first attempt. */
  attempt: number;
}

export type JobHandler = (payload: Record<string, unknown>, ctx: JobContext) => Promise<void>;

const OrgPayload = z.object({ orgId: z.uuid() });
const PropertyPayload = z.object({ orgId: z.uuid(), propertyId: z.uuid() });
const CrawlPayload = z.object({ orgId: z.uuid(), crawlId: z.uuid() });
const ReservationChanged = z.object({
  orgId: z.uuid(),
  pmsReservationId: z.string(),
  event: z.string().optional(),
});

/** A job that should be retried later without counting as a failure (e.g. upstream rate limit). */
export class RetryLaterError extends Error {
  constructor(
    message: string,
    readonly delaySeconds: number,
  ) {
    super(message);
  }
}

/**
 * Every background job type and its handler. Handlers must be idempotent: SQS delivers at least
 * once and the Postgres queue retries after a crash.
 */
export function createJobHandlers(container: Container): Record<string, JobHandler> {
  const { services, db, clock, queue } = container;
  return {
    'outbox.dispatch': async () => {
      await services.outbox.dispatchBatch(100);
    },
    'pms.sync': async (payload) => {
      const { orgId } = OrgPayload.parse(payload);
      await services.pmsSync.syncOrganization(orgId);
    },
    'pms.sync-all': async () => {
      const connections = await db.system(({ pms }) => pms.activeConnections());
      for (const c of connections) {
        await queue.enqueue({ type: 'pms.sync', payload: { orgId: c.organizationId } });
      }
    },
    'pms.reservation-changed': async (payload, ctx) => {
      const { orgId, pmsReservationId } = ReservationChanged.parse(payload);
      const client = await services.pmsConnections.clientFor(orgId);
      const reservation = await client.getReservation(pmsReservationId);
      ctx.logger.info({ orgId, pmsReservationId, status: reservation?.status }, 'PMS reservation changed');
    },
    'profile.map-pms': async (payload) => {
      const { orgId, propertyId } = PropertyPayload.parse(payload);
      await services.catalog.mapPmsAttributes(orgId, propertyId);
    },
    'profile.embed': async (payload) => {
      const { orgId, propertyId } = PropertyPayload.parse(payload);
      await services.catalog.refreshEmbeddings(orgId, propertyId);
    },
    'website.crawl': async (payload) => {
      const { orgId, crawlId } = CrawlPayload.parse(payload);
      await services.websiteImport.run(orgId, crawlId);
    },
    'holds.expire': async (_payload, ctx) => {
      const expired = await db.system(({ holds }) => holds.expireDue(clock.now()));
      if (expired > 0) ctx.logger.info({ expired }, 'holds expired');
    },
    'offers.cleanup': async () => {
      await db.system(({ pms }) =>
        pms.deleteExpiredQuotes(new Date(clock.now().getTime() - 24 * 3600 * 1000)),
      );
    },
  };
}
