import { and, eq, gte, lt, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { agentClients, agentEvents, bookings, holds } from '../schema';

export interface FunnelWindow {
  from: Date;
  to: Date;
  /** IANA zone the daily buckets are cut in. */
  timeZone: string;
  propertyId?: string;
}

export interface AgentKey {
  agentClientId: string | null;
  partnerName: string | null;
  clientName: string | null;
  channel: 'mcp' | 'rest';
}

export type FunnelEventCount = AgentKey & {
  day: string;
  kind: 'search_impression' | 'hotel_view' | 'offers_view' | 'hold_created';
  count: number;
};

export type FunnelBookingCount = AgentKey & {
  day: string;
  started: number;
  paid: number;
  reserved: number;
};

/** Aggregates for the per-hotel agent funnel (no guest data involved). */
export function funnelRepo(tx: Tx, orgId: string) {
  return {
    async eventCounts(w: FunnelWindow): Promise<FunnelEventCount[]> {
      const day = sql<string>`to_char(${agentEvents.createdAt} at time zone ${w.timeZone}, 'YYYY-MM-DD')`;
      return tx
        .select({
          day,
          kind: agentEvents.kind,
          agentClientId: agentEvents.agentClientId,
          partnerName: agentClients.name,
          clientName: agentEvents.clientName,
          channel: agentEvents.channel,
          count: sql<number>`count(*)::int`,
        })
        .from(agentEvents)
        .leftJoin(agentClients, eq(agentClients.id, agentEvents.agentClientId))
        .where(
          and(
            eq(agentEvents.organizationId, orgId),
            gte(agentEvents.createdAt, w.from),
            lt(agentEvents.createdAt, w.to),
            w.propertyId ? eq(agentEvents.propertyId, w.propertyId) : undefined,
          ),
        )
        .groupBy(
          sql`1`,
          agentEvents.kind,
          agentEvents.agentClientId,
          agentClients.name,
          agentEvents.clientName,
          agentEvents.channel,
        );
    },

    /** Checkouts started, paid and turned into reservations, by the day the checkout started. */
    async bookingCounts(w: FunnelWindow): Promise<FunnelBookingCount[]> {
      const day = sql<string>`to_char(${bookings.createdAt} at time zone ${w.timeZone}, 'YYYY-MM-DD')`;
      return tx
        .select({
          day,
          agentClientId: bookings.agentClientId,
          partnerName: agentClients.name,
          clientName: holds.clientName,
          channel: bookings.channel,
          started: sql<number>`count(*)::int`,
          paid: sql<number>`(count(*) filter (where ${bookings.paymentAuthorizedAt} is not null))::int`,
          reserved: sql<number>`(count(*) filter (where ${bookings.pmsReservationId} is not null))::int`,
        })
        .from(bookings)
        .innerJoin(holds, eq(holds.id, bookings.holdId))
        .leftJoin(agentClients, eq(agentClients.id, bookings.agentClientId))
        .where(
          and(
            eq(bookings.organizationId, orgId),
            gte(bookings.createdAt, w.from),
            lt(bookings.createdAt, w.to),
            w.propertyId ? eq(bookings.propertyId, w.propertyId) : undefined,
          ),
        )
        .groupBy(sql`1`, bookings.agentClientId, agentClients.name, holds.clientName, bookings.channel);
    },
  };
}
