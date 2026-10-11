import { agentLabel, buildFunnel, type Clock, can, NotFoundError, toCsv } from '@lodgent/core';
import type { BookingListRow, BookingSearch, Database } from '@lodgent/db';
import {
  addDays,
  type BookingDetailDto,
  type BookingListDto,
  type BookingListItemDto,
  FUNNEL_STAGES,
  type FunnelDto,
  isValidTimeZone,
  localDateAt,
  nightsBetween,
  toMajor,
} from '@lodgent/shared';
import { assertCan, type OrgContext } from '../context';

const DAY_MS = 86_400_000;

export interface BookingListFilters {
  propertyId?: string;
  status?: BookingSearch['statuses'];
  from?: string;
  to?: string;
  q?: string;
  limit: number;
  offset: number;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** The value most entries share; undefined when there is no single winner. */
function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const [first, second] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return first && (!second || second[1] < first[1]) ? first[0] : undefined;
}

/**
 * The hotel's view of agent bookings: the list and detail with fees, the CSV export, and the agent
 * funnel from first search to PMS reservation.
 */
export class BookingsService {
  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      /** e.g. `https://app.apaleo.com/{propertyId}/reservations/{reservationId}` */
      pmsReservationUrlTemplate: string;
      /** Stripe Dashboard base for the hotel's own account; null with the simulated provider. */
      paymentsDashboardUrl: string | null;
    },
  ) {}

  private pmsUrl(pmsPropertyId: string | null, reservationId: string | null): string | null {
    if (!pmsPropertyId || !reservationId) return null;
    return this.deps.pmsReservationUrlTemplate
      .replace('{propertyId}', encodeURIComponent(pmsPropertyId))
      .replace('{reservationId}', encodeURIComponent(reservationId));
  }

  private toItem(row: BookingListRow): BookingListItemDto {
    const b = row.booking;
    const guestName = b.piiRedactedAt
      ? null
      : [b.guestFirstName, b.guestLastName].filter(Boolean).join(' ').trim() || null;
    return {
      id: b.id,
      reference: b.reference,
      propertyId: b.propertyId,
      propertyName: row.propertyName,
      status: b.status,
      statusReason: b.statusReason,
      paymentMode: b.paymentMode,
      currency: b.currency,
      totalAmount: b.totalAmount,
      feeBps: b.feeBps,
      feeAmount: b.feeAmount,
      feeStatus: row.feeStatus,
      arrival: b.arrival,
      departure: b.departure,
      nights: nightsBetween(b.arrival, b.departure),
      adults: b.adults,
      children: b.childrenAges.length,
      roomTypeName: row.offer.roomTypeName,
      ratePlanName: row.offer.ratePlanName,
      guestName,
      agent: agentLabel({
        agentClientId: b.agentClientId,
        partnerName: row.partnerName,
        clientName: row.clientName,
        channel: b.channel,
      }),
      confirmationNumber: b.confirmationNumber,
      pmsReservationId: b.pmsReservationId,
      pmsUrl: this.pmsUrl(row.pmsPropertyId, b.pmsReservationId),
      createdAt: b.createdAt.toISOString(),
      confirmedAt: iso(b.confirmedAt),
      cancelledAt: iso(b.cancelledAt),
    };
  }

  private search(filters: BookingListFilters): BookingSearch {
    return {
      propertyId: filters.propertyId,
      statuses: filters.status,
      createdFrom: filters.from ? new Date(`${filters.from}T00:00:00Z`) : undefined,
      createdTo: filters.to ? new Date(`${filters.to}T00:00:00Z`) : undefined,
      q: filters.q,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async list(ctx: OrgContext, filters: BookingListFilters): Promise<BookingListDto> {
    assertCan(ctx, 'bookings.read');
    const { rows, total } = await this.deps.db.tenant(ctx.orgId, (r) =>
      r.bookings.search(this.search(filters)),
    );
    return {
      bookings: rows.map((row) => this.toItem(row)),
      total,
      limit: filters.limit,
      offset: filters.offset,
    };
  }

  async detail(ctx: OrgContext, bookingId: string): Promise<BookingDetailDto> {
    assertCan(ctx, 'bookings.read');
    return this.deps.db.tenant(ctx.orgId, async (r) => {
      const { rows } = await r.bookings.search({ id: bookingId, limit: 1 });
      const row = rows[0];
      if (!row) throw new NotFoundError('Booking');
      const fee = await r.fees.forBooking(bookingId);
      const invoice = fee?.invoiceId ? await r.billing.invoice(fee.invoiceId) : undefined;
      const item = this.toItem(row);
      const b = row.booking;
      const showContact = can(ctx.role, 'guest-data.manage') && !b.piiRedactedAt;
      const offer = row.offer;

      const timeline: { at: string; label: string }[] = [
        { at: b.createdAt.toISOString(), label: 'Checkout started' },
      ];
      if (b.paymentAuthorizedAt) {
        timeline.push({
          at: b.paymentAuthorizedAt.toISOString(),
          label: b.paymentMode === 'prepaid' ? 'Payment authorized' : 'Card saved as guarantee',
        });
      }
      if (b.confirmedAt) {
        timeline.push({
          at: b.confirmedAt.toISOString(),
          label: `Reservation confirmed${b.confirmationNumber ? ` (${b.confirmationNumber})` : ''}`,
        });
      }
      if (b.status === 'failed') {
        timeline.push({
          at: b.updatedAt.toISOString(),
          label: `Failed: ${b.statusReason ?? 'unknown reason'}`,
        });
      }
      if (b.cancelledAt) timeline.push({ at: b.cancelledAt.toISOString(), label: 'Reservation cancelled' });
      if (b.piiRedactedAt) timeline.push({ at: b.piiRedactedAt.toISOString(), label: 'Guest data erased' });
      timeline.sort((x, y) => x.at.localeCompare(y.at));

      const dashboard = this.deps.paymentsDashboardUrl;
      return {
        ...item,
        guestEmail: showContact ? b.guestEmail : null,
        guestPhone: showContact ? b.guestPhone : null,
        specialRequests: b.piiRedactedAt ? null : b.specialRequests,
        piiRedactedAt: iso(b.piiRedactedAt),
        dueNowAmount: b.dueNowAmount,
        price: {
          accommodation: offer.accommodation.amount,
          includedTaxes: offer.includedTaxes.amount,
          extras: offer.extras.map((e) => ({ label: e.label, amount: e.amount.amount })),
          nightly: offer.nightly.map((n) => ({ date: n.date, amount: n.amount.amount })),
        },
        cancellation: {
          name: offer.cancellation.name,
          description: offer.cancellation.description,
          freeUntil: offer.cancellation.freeUntil,
        },
        payment: {
          status: b.paymentStatus,
          paymentIntentId: b.paymentIntentId,
          setupIntentId: b.setupIntentId,
          dashboardUrl: dashboard && b.paymentIntentId ? `${dashboard}/payments/${b.paymentIntentId}` : null,
        },
        fee: fee
          ? {
              collection: fee.collection,
              status: fee.status,
              amount: fee.amount,
              invoiceNumber: invoice?.number ?? null,
            }
          : null,
        timeline,
      };
    });
  }

  /** Spreadsheet export (amounts in major units). Guest contact details are left out. */
  async exportCsv(ctx: OrgContext, filters: Omit<BookingListFilters, 'limit' | 'offset'>): Promise<string> {
    assertCan(ctx, 'bookings.read');
    const rows: BookingListRow[] = [];
    await this.deps.db.tenant(ctx.orgId, async (r) => {
      // Page through sequentially (one transaction, one connection).
      for (let offset = 0; offset < 50_000; offset += 1_000) {
        const page = await r.bookings.search(this.search({ ...filters, limit: 1_000, offset }));
        rows.push(...page.rows);
        if (page.rows.length < 1_000) break;
      }
    });
    const major = (amount: number, currency: string) => toMajor({ amount, currency });
    return toCsv(
      [
        'reference',
        'property',
        'status',
        'booked_at',
        'arrival',
        'departure',
        'nights',
        'guest_name',
        'room',
        'rate',
        'payment',
        'currency',
        'total',
        'fee_percent',
        'fee',
        'fee_status',
        'agent',
        'channel',
        'confirmation_number',
      ],
      rows.map((row) => {
        const b = this.toItem(row);
        return [
          b.reference,
          b.propertyName,
          b.status,
          b.createdAt,
          b.arrival,
          b.departure,
          b.nights,
          b.guestName,
          b.roomTypeName,
          b.ratePlanName,
          b.paymentMode,
          b.currency,
          major(b.totalAmount, b.currency),
          b.feeBps / 100,
          major(b.feeAmount, b.currency),
          b.feeStatus,
          b.agent.name,
          b.agent.channel,
          b.confirmationNumber,
        ];
      }),
    );
  }

  async funnel(ctx: OrgContext, input: { propertyId?: string; days: number }): Promise<FunnelDto> {
    assertCan(ctx, 'bookings.read');
    const { db, clock } = this.deps;
    return db.tenant(ctx.orgId, async (r) => {
      const properties = await r.properties.list();
      const property = input.propertyId ? properties.find((p) => p.id === input.propertyId) : undefined;
      if (input.propertyId && !property) throw new NotFoundError('Property');
      // Days are cut in the property's zone (or the group's most common one, else UTC).
      const zone = property?.timeZone ?? mostCommon(properties.map((p) => p.timeZone));
      const timeZone = zone && isValidTimeZone(zone) ? zone : 'UTC';
      const today = localDateAt(clock.now(), timeZone);
      const to = addDays(today, 1);
      const from = addDays(to, -input.days);
      // Instants bounding the local days (a day of slack each side; the day buckets trim it).
      const window = {
        from: new Date(new Date(`${from}T00:00:00Z`).getTime() - DAY_MS),
        to: new Date(new Date(`${to}T00:00:00Z`).getTime() + DAY_MS),
        timeZone,
        propertyId: input.propertyId,
      };
      const events = await r.funnel.eventCounts(window);
      const bookings = await r.funnel.bookingCounts(window);
      const inWindow = <T extends { day: string }>(rows: T[]) =>
        rows.filter((x) => x.day >= from && x.day < to);
      const funnel = buildFunnel({ from, to, events: inWindow(events), bookings: inWindow(bookings) });
      return {
        from,
        to,
        timeZone,
        totals: funnel.totals,
        stages: funnel.stages.map((s) => ({
          ...s,
          label: FUNNEL_STAGES.find((x) => x.key === s.key)?.label ?? s.key,
        })),
        byAgent: funnel.byAgent,
        daily: funnel.daily,
      };
    });
  }
}
