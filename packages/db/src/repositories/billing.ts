import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { bookings, feeInvoices, feeLedger, organizations, properties } from '../schema';
import type { FeeLedgerRow } from './bookings';

export type FeeInvoiceRow = typeof feeInvoices.$inferSelect;
export type FeeInvoiceStatus = FeeInvoiceRow['status'];

export interface FeeLine {
  fee: FeeLedgerRow;
  reference: string;
  propertyName: string;
  arrival: string;
  departure: string;
  bookingStatus: string;
}

/** Fee ledger reporting and monthly fee invoices for one organization. */
export function billingRepo(tx: Tx, orgId: string) {
  const ownFee = eq(feeLedger.organizationId, orgId);
  const ownInvoice = eq(feeInvoices.organizationId, orgId);
  const lineColumns = {
    fee: feeLedger,
    reference: bookings.reference,
    propertyName: properties.name,
    arrival: bookings.arrival,
    departure: bookings.departure,
    bookingStatus: bookings.status,
  };
  return {
    /** Fee lines for bookings confirmed in [from, to), newest first. */
    async lines(filters: { from?: Date; to?: Date; invoiceId?: string; limit?: number }): Promise<FeeLine[]> {
      return tx
        .select(lineColumns)
        .from(feeLedger)
        .innerJoin(bookings, eq(bookings.id, feeLedger.bookingId))
        .innerJoin(properties, eq(properties.id, feeLedger.propertyId))
        .where(
          and(
            ownFee,
            filters.from ? gte(feeLedger.occurredAt, filters.from) : undefined,
            filters.to ? lt(feeLedger.occurredAt, filters.to) : undefined,
            filters.invoiceId ? eq(feeLedger.invoiceId, filters.invoiceId) : undefined,
          ),
        )
        .orderBy(desc(feeLedger.occurredAt), desc(feeLedger.id))
        .limit(filters.limit ?? 5_000);
    },

    /** Totals per month (UTC, by confirmation time), collection, status and currency. */
    async monthlyTotals(since: Date): Promise<
      {
        period: string;
        currency: string;
        collection: FeeLedgerRow['collection'];
        status: FeeLedgerRow['status'];
        amount: number;
        bookingTotal: number;
        count: number;
      }[]
    > {
      return tx
        .select({
          period: sql<string>`to_char(${feeLedger.occurredAt} at time zone 'UTC', 'YYYY-MM')`,
          currency: feeLedger.currency,
          collection: feeLedger.collection,
          status: feeLedger.status,
          amount: sql<number>`sum(${feeLedger.amount})::bigint`.mapWith(Number),
          bookingTotal: sql<number>`sum(${feeLedger.bookingTotalAmount})::bigint`.mapWith(Number),
          count: sql<number>`count(*)::int`,
        })
        .from(feeLedger)
        .where(and(ownFee, gte(feeLedger.occurredAt, since)))
        .groupBy(sql`1`, feeLedger.currency, feeLedger.collection, feeLedger.status)
        .orderBy(sql`1 desc`);
    },

    /**
     * Pay-at-hotel fees not yet invoiced for stays that ended before `departedBefore` (a date),
     * locked so two invoicing runs cannot take the same fee.
     */
    async uninvoicedForStaysBefore(departedBefore: string, currency: string): Promise<FeeLine[]> {
      return tx
        .select(lineColumns)
        .from(feeLedger)
        .innerJoin(bookings, eq(bookings.id, feeLedger.bookingId))
        .innerJoin(properties, eq(properties.id, feeLedger.propertyId))
        .where(
          and(
            ownFee,
            eq(feeLedger.collection, 'invoice'),
            eq(feeLedger.status, 'pending'),
            isNull(feeLedger.invoiceId),
            eq(feeLedger.currency, currency),
            lt(bookings.departure, departedBefore),
          ),
        )
        .orderBy(asc(bookings.departure), asc(feeLedger.id))
        .for('update', { of: feeLedger });
    },

    async pendingCurrencies(departedBefore: string): Promise<string[]> {
      const rows = await tx
        .selectDistinct({ currency: feeLedger.currency })
        .from(feeLedger)
        .innerJoin(bookings, eq(bookings.id, feeLedger.bookingId))
        .where(
          and(
            ownFee,
            eq(feeLedger.collection, 'invoice'),
            eq(feeLedger.status, 'pending'),
            isNull(feeLedger.invoiceId),
            lt(bookings.departure, departedBefore),
          ),
        );
      return rows.map((r) => r.currency).sort();
    },

    async assignToInvoice(feeIds: string[], invoiceId: string): Promise<void> {
      if (feeIds.length === 0) return;
      await tx
        .update(feeLedger)
        .set({ invoiceId, status: 'invoiced' })
        .where(and(ownFee, inArray(feeLedger.id, feeIds)));
    },

    async setFeeStatusForInvoice(invoiceId: string, status: FeeLedgerRow['status']): Promise<void> {
      await tx
        .update(feeLedger)
        .set({ status })
        .where(and(ownFee, eq(feeLedger.invoiceId, invoiceId)));
    },

    async invoiceFor(period: string, currency: string): Promise<FeeInvoiceRow | undefined> {
      const [row] = await tx
        .select()
        .from(feeInvoices)
        .where(and(ownInvoice, eq(feeInvoices.period, period), eq(feeInvoices.currency, currency)));
      return row;
    },

    /** Creates the period's invoice row unless it exists; returns null when another run created it. */
    async createInvoice(
      values: Pick<FeeInvoiceRow, 'period' | 'currency' | 'amount' | 'feeCount'>,
    ): Promise<FeeInvoiceRow | null> {
      const [row] = await tx
        .insert(feeInvoices)
        .values({ ...values, organizationId: orgId })
        .onConflictDoNothing()
        .returning();
      return row ?? null;
    },

    async invoice(id: string): Promise<FeeInvoiceRow | undefined> {
      const [row] = await tx
        .select()
        .from(feeInvoices)
        .where(and(ownInvoice, eq(feeInvoices.id, id)));
      return row;
    },

    async invoices(limit = 24): Promise<FeeInvoiceRow[]> {
      return tx
        .select()
        .from(feeInvoices)
        .where(ownInvoice)
        .orderBy(desc(feeInvoices.period), asc(feeInvoices.currency))
        .limit(limit);
    },

    async updateInvoice(
      id: string,
      patch: Partial<Omit<FeeInvoiceRow, 'id' | 'organizationId' | 'createdAt'>>,
    ): Promise<FeeInvoiceRow | undefined> {
      const [row] = await tx
        .update(feeInvoices)
        .set(patch)
        .where(and(ownInvoice, eq(feeInvoices.id, id)))
        .returning();
      return row;
    },
  };
}

/** Cross-tenant billing work: finding who to invoice and mapping provider invoices back. */
export function billingSystemRepo(tx: Tx) {
  return {
    /** Organizations with pay-at-hotel fees awaiting an invoice for stays ended before the date. */
    async orgsWithUninvoicedFees(departedBefore: string): Promise<string[]> {
      const rows = await tx
        .selectDistinct({ organizationId: feeLedger.organizationId })
        .from(feeLedger)
        .innerJoin(bookings, eq(bookings.id, feeLedger.bookingId))
        .where(
          and(
            eq(feeLedger.collection, 'invoice'),
            eq(feeLedger.status, 'pending'),
            isNull(feeLedger.invoiceId),
            lt(bookings.departure, departedBefore),
          ),
        );
      return rows.map((r) => r.organizationId);
    },
    /** Invoice rows not yet issued at the provider (a run that stopped half-way). */
    async draftInvoices(): Promise<{ organizationId: string; id: string }[]> {
      return tx
        .select({ organizationId: feeInvoices.organizationId, id: feeInvoices.id })
        .from(feeInvoices)
        .where(eq(feeInvoices.status, 'draft'));
    },
    async openInvoices(): Promise<{ organizationId: string; id: string }[]> {
      return tx
        .select({ organizationId: feeInvoices.organizationId, id: feeInvoices.id })
        .from(feeInvoices)
        .where(eq(feeInvoices.status, 'open'));
    },
    /** Properties with their organization, for operator tools (fee rates). */
    async properties(): Promise<
      { id: string; name: string; organizationId: string; organizationName: string; feeBps: number }[]
    > {
      return tx
        .select({
          id: properties.id,
          name: properties.name,
          organizationId: properties.organizationId,
          organizationName: organizations.name,
          feeBps: properties.feeBps,
        })
        .from(properties)
        .innerJoin(organizations, eq(organizations.id, properties.organizationId))
        .orderBy(asc(organizations.name), asc(properties.name));
    },
    async invoiceOwner(id: string): Promise<{ organizationId: string } | undefined> {
      const [row] = await tx
        .select({ organizationId: feeInvoices.organizationId })
        .from(feeInvoices)
        .where(eq(feeInvoices.id, id));
      return row;
    },
    async byProviderInvoice(
      providerInvoiceId: string,
    ): Promise<{ organizationId: string; id: string } | undefined> {
      const [row] = await tx
        .select({ organizationId: feeInvoices.organizationId, id: feeInvoices.id })
        .from(feeInvoices)
        .where(eq(feeInvoices.providerInvoiceId, providerInvoiceId));
      return row;
    },
  };
}
