import { and, desc, eq, gt, gte, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { agentClients, bookings, feeLedger, holds, paymentAccounts, properties } from '../schema';
import type { OfferQuoteDetails } from '../schema/pms';

export type HoldRow = typeof holds.$inferSelect;
export type NewHold = Omit<typeof holds.$inferInsert, 'organizationId' | 'id' | 'createdAt' | 'updatedAt'>;
export type HoldStatus = HoldRow['status'];
export type PaymentAccountRow = typeof paymentAccounts.$inferSelect;
export type BookingRow = typeof bookings.$inferSelect;
export type NewBooking = Omit<
  typeof bookings.$inferInsert,
  'organizationId' | 'id' | 'createdAt' | 'updatedAt'
>;
export type BookingStatus = BookingRow['status'];
export type FeeLedgerRow = typeof feeLedger.$inferSelect;

export interface BookingSearch {
  id?: string;
  propertyId?: string;
  statuses?: BookingStatus[];
  createdFrom?: Date;
  createdTo?: Date;
  /** Booking reference, confirmation number or guest surname (substring). */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface BookingListRow {
  booking: BookingRow;
  propertyName: string;
  pmsPropertyId: string | null;
  timeZone: string;
  offer: OfferQuoteDetails;
  clientName: string | null;
  partnerName: string | null;
  feeStatus: FeeLedgerRow['status'] | null;
  feeCollection: FeeLedgerRow['collection'] | null;
  feeInvoiceId: string | null;
}

export const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

export function holdRepo(tx: Tx, orgId: string) {
  const own = eq(holds.organizationId, orgId);
  return {
    async create(values: NewHold): Promise<HoldRow> {
      const [row] = await tx
        .insert(holds)
        .values({ ...values, organizationId: orgId })
        .returning();
      return row!;
    },
    async get(id: string): Promise<HoldRow | undefined> {
      const [row] = await tx
        .select()
        .from(holds)
        .where(and(own, eq(holds.id, id)));
      return row;
    },
    /** Serializes hold creation per room type (row lock until the transaction ends). */
    async lockRoomType(roomTypeId: string): Promise<void> {
      await tx.execute(
        sql`select 1 from room_types where id = ${roomTypeId} and organization_id = ${orgId} for update`,
      );
    },
    /** Holds still competing for the same room type on overlapping nights. */
    async countActiveOverlapping(
      roomTypeId: string,
      arrival: string,
      departure: string,
      now: Date,
    ): Promise<number> {
      const [row] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(holds)
        .where(
          and(
            own,
            eq(holds.roomTypeId, roomTypeId),
            inArray(holds.status, ['active', 'processing']),
            gt(holds.expiresAt, now),
            lt(holds.arrival, departure),
            gt(holds.departure, arrival),
          ),
        );
      return row?.n ?? 0;
    },
    async setStatus(
      id: string,
      status: HoldStatus,
      reason: string | null = null,
    ): Promise<HoldRow | undefined> {
      const [row] = await tx
        .update(holds)
        .set({ status, statusReason: reason })
        .where(and(own, eq(holds.id, id)))
        .returning();
      return row;
    },
  };
}

/** Cross-tenant hold maintenance and lookups by id (agents only know the hold id). */
export function holdSystemRepo(tx: Tx) {
  return {
    async owner(id: string): Promise<{ organizationId: string; propertyId: string } | undefined> {
      const [row] = await tx
        .select({ organizationId: holds.organizationId, propertyId: holds.propertyId })
        .from(holds)
        .where(eq(holds.id, id));
      return row;
    },
    /** Marks active holds past their expiry as expired; returns how many. */
    async expireDue(now: Date): Promise<number> {
      // Holds whose guest already started checkout are closed by checkout reconciliation instead.
      const result = await tx
        .update(holds)
        .set({ status: 'expired', statusReason: 'Checkout not completed in time' })
        .where(
          and(
            eq(holds.status, 'active'),
            lt(holds.expiresAt, now),
            sql`not exists (select 1 from bookings b where b.hold_id = ${holds.id})`,
          ),
        );
      return result.rowCount ?? 0;
    },
  };
}

export function paymentAccountRepo(tx: Tx, orgId: string) {
  const own = eq(paymentAccounts.organizationId, orgId);
  return {
    async get(): Promise<PaymentAccountRow | undefined> {
      const [row] = await tx.select().from(paymentAccounts).where(own);
      return row;
    },
    async create(
      values: Omit<typeof paymentAccounts.$inferInsert, 'organizationId' | 'id'>,
    ): Promise<PaymentAccountRow> {
      const [row] = await tx
        .insert(paymentAccounts)
        .values({ ...values, organizationId: orgId })
        .returning();
      return row!;
    },
    async update(
      patch: Partial<Omit<PaymentAccountRow, 'id' | 'organizationId' | 'createdAt'>>,
    ): Promise<PaymentAccountRow | undefined> {
      const [row] = await tx.update(paymentAccounts).set(patch).where(own).returning();
      return row;
    },
  };
}

export function bookingRepo(tx: Tx, orgId: string) {
  const own = eq(bookings.organizationId, orgId);
  return {
    async create(values: NewBooking): Promise<BookingRow> {
      const [row] = await tx
        .insert(bookings)
        .values({ ...values, organizationId: orgId })
        .returning();
      return row!;
    },
    async get(id: string): Promise<BookingRow | undefined> {
      const [row] = await tx
        .select()
        .from(bookings)
        .where(and(own, eq(bookings.id, id)));
      return row;
    },
    /** Locks the booking row until the transaction ends (serializes finalization). */
    async getForUpdate(id: string): Promise<BookingRow | undefined> {
      const [row] = await tx
        .select()
        .from(bookings)
        .where(and(own, eq(bookings.id, id)))
        .for('update');
      return row;
    },
    async byHold(holdId: string): Promise<BookingRow | undefined> {
      const [row] = await tx
        .select()
        .from(bookings)
        .where(and(own, eq(bookings.holdId, holdId)));
      return row;
    },
    /**
     * Claims a booking for finalization (compare-and-set): pending payment, or a finalization that
     * stalled for longer than the lease (a crashed worker). Returns null if someone else holds it.
     */
    async claim(id: string, now: Date, leaseMs: number): Promise<BookingRow | null> {
      const stale = new Date(now.getTime() - leaseMs);
      const [row] = await tx
        .update(bookings)
        .set({
          status: 'reserving',
          updatedAt: now,
          paymentAuthorizedAt: sql`coalesce(${bookings.paymentAuthorizedAt}, ${now})`,
        })
        .where(
          and(
            own,
            eq(bookings.id, id),
            or(
              eq(bookings.status, 'pending_payment'),
              and(eq(bookings.status, 'reserving'), lt(bookings.updatedAt, stale)),
            ),
          ),
        )
        .returning();
      return row ?? null;
    },
    async byPmsReservation(pmsReservationId: string): Promise<BookingRow | undefined> {
      const [row] = await tx
        .select()
        .from(bookings)
        .where(and(own, eq(bookings.pmsReservationId, pmsReservationId)));
      return row;
    },
    async update(
      id: string,
      patch: Partial<Omit<BookingRow, 'id' | 'organizationId' | 'createdAt'>>,
    ): Promise<BookingRow | undefined> {
      const [row] = await tx
        .update(bookings)
        .set(patch)
        .where(and(own, eq(bookings.id, id)))
        .returning();
      return row;
    },
    async list(options: { propertyId?: string; limit?: number } = {}): Promise<BookingRow[]> {
      return tx
        .select()
        .from(bookings)
        .where(and(own, options.propertyId ? eq(bookings.propertyId, options.propertyId) : undefined))
        .orderBy(desc(bookings.createdAt))
        .limit(options.limit ?? 100);
    },
    /** Bookings with what the dashboard shows alongside them (property, offer snapshot, agent, fee). */
    async search(filters: BookingSearch): Promise<{ rows: BookingListRow[]; total: number }> {
      const where = and(
        own,
        filters.id ? eq(bookings.id, filters.id) : undefined,
        filters.propertyId ? eq(bookings.propertyId, filters.propertyId) : undefined,
        filters.statuses?.length ? inArray(bookings.status, filters.statuses) : undefined,
        filters.createdFrom ? gte(bookings.createdAt, filters.createdFrom) : undefined,
        filters.createdTo ? lt(bookings.createdAt, filters.createdTo) : undefined,
        filters.q
          ? or(
              ilike(bookings.reference, `%${escapeLike(filters.q)}%`),
              ilike(bookings.confirmationNumber, `%${escapeLike(filters.q)}%`),
              ilike(bookings.guestLastName, `%${escapeLike(filters.q)}%`),
            )
          : undefined,
      );
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(bookings).where(where);
      const rows = await tx
        .select({
          booking: bookings,
          propertyName: properties.name,
          pmsPropertyId: properties.pmsPropertyId,
          timeZone: properties.timeZone,
          offer: holds.offer,
          clientName: holds.clientName,
          partnerName: agentClients.name,
          feeStatus: feeLedger.status,
          feeCollection: feeLedger.collection,
          feeInvoiceId: feeLedger.invoiceId,
        })
        .from(bookings)
        .innerJoin(properties, eq(properties.id, bookings.propertyId))
        .innerJoin(holds, eq(holds.id, bookings.holdId))
        .leftJoin(agentClients, eq(agentClients.id, bookings.agentClientId))
        .leftJoin(feeLedger, eq(feeLedger.bookingId, bookings.id))
        .where(where)
        .orderBy(desc(bookings.createdAt), desc(bookings.id))
        .limit(filters.limit ?? 50)
        .offset(filters.offset ?? 0);
      return { rows, total: count?.n ?? 0 };
    },
  };
}

export function feeLedgerRepo(tx: Tx, orgId: string) {
  const own = eq(feeLedger.organizationId, orgId);
  return {
    /** One entry per booking; repeated calls keep the first. */
    async record(values: Omit<typeof feeLedger.$inferInsert, 'organizationId' | 'id'>): Promise<void> {
      await tx
        .insert(feeLedger)
        .values({ ...values, organizationId: orgId })
        .onConflictDoNothing({ target: feeLedger.bookingId });
    },
    async forBooking(bookingId: string): Promise<FeeLedgerRow | undefined> {
      const [row] = await tx
        .select()
        .from(feeLedger)
        .where(and(own, eq(feeLedger.bookingId, bookingId)));
      return row;
    },
    async setStatus(bookingId: string, status: FeeLedgerRow['status']): Promise<void> {
      await tx
        .update(feeLedger)
        .set({ status })
        .where(and(own, eq(feeLedger.bookingId, bookingId)));
    },
  };
}

/** Cross-tenant lookups for webhooks and the reconciliation job. */
export function bookingSystemRepo(tx: Tx) {
  return {
    async owner(bookingId: string): Promise<{ organizationId: string } | undefined> {
      const [row] = await tx
        .select({ organizationId: bookings.organizationId })
        .from(bookings)
        .where(eq(bookings.id, bookingId));
      return row;
    },
    async byHold(holdId: string): Promise<{ organizationId: string; bookingId: string } | undefined> {
      const [row] = await tx
        .select({ organizationId: bookings.organizationId, bookingId: bookings.id })
        .from(bookings)
        .where(eq(bookings.holdId, holdId));
      return row;
    },
    async paymentAccountOrg(accountId: string): Promise<{ organizationId: string } | undefined> {
      const [row] = await tx
        .select({ organizationId: paymentAccounts.organizationId })
        .from(paymentAccounts)
        .where(eq(paymentAccounts.accountId, accountId));
      return row;
    },
    /** Bookings stuck between payment and confirmation for longer than `olderThan`. */
    async stuck(olderThan: Date, limit = 50): Promise<{ organizationId: string; bookingId: string }[]> {
      return tx
        .select({ organizationId: bookings.organizationId, bookingId: bookings.id })
        .from(bookings)
        .where(
          and(inArray(bookings.status, ['pending_payment', 'reserving']), lt(bookings.updatedAt, olderThan)),
        )
        .orderBy(bookings.updatedAt)
        .limit(limit);
    },
    /** Pay-at-hotel and prepaid bookings whose guest data is past retention. */
    async piiExpired(before: string, limit = 200): Promise<{ organizationId: string; bookingId: string }[]> {
      return tx
        .select({ organizationId: bookings.organizationId, bookingId: bookings.id })
        .from(bookings)
        .where(and(lt(bookings.departure, before), sql`${bookings.piiRedactedAt} is null`))
        .limit(limit);
    },
  };
}
