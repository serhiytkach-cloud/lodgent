import {
  type Clock,
  describeCancellation,
  NotFoundError,
  type PmsOffer,
  UnprocessableError,
  ValidationError,
} from '@lodgent/core';
import type { Database, OfferQuoteDetails, OfferQuoteRow, PropertyRow } from '@lodgent/db';
import {
  compareLocalDates,
  localDateAt,
  type Money,
  nightsBetween,
  type OfferDto,
  toDisplayMoney,
} from '@lodgent/shared';
import type { PmsConnectionService } from './pms-connections';

export interface OfferSearch {
  propertyId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  childrenAges: number[];
}

export interface OfferResult {
  property: PropertyRow;
  quotes: OfferQuoteRow[];
  fromCache: boolean;
}

export function offerQueryKey(
  s: Pick<OfferSearch, 'checkIn' | 'checkOut' | 'adults' | 'childrenAges'>,
): string {
  return `${s.checkIn}|${s.checkOut}|${s.adults}|${[...s.childrenAges].sort((a, b) => a - b).join(',')}`;
}

/**
 * Live offers from the PMS, limited to rate plans the hotel exposed to agents and that we can take
 * payment for. Each offer is stored as a quote (the short-TTL cache and the basis for holds).
 */
export class OfferService {
  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      connections: PmsConnectionService;
      cacheTtlSeconds: number;
      validityMinutes: number;
    },
  ) {}

  validateStay(property: Pick<PropertyRow, 'timeZone'>, s: Omit<OfferSearch, 'propertyId'>): void {
    const today = localDateAt(this.deps.clock.now(), property.timeZone);
    if (compareLocalDates(s.checkIn, today) < 0)
      throw new ValidationError('checkIn is in the past for this hotel');
    const nights = nightsBetween(s.checkIn, s.checkOut);
    if (nights < 1) throw new ValidationError('checkOut must be after checkIn');
    if (nights > 30) throw new ValidationError('Stays are limited to 30 nights');
    if (nightsBetween(today, s.checkIn) > 500) throw new ValidationError('checkIn is too far in the future');
  }

  /** Agent-facing offers (cached). Property must be published unless `allowUnpublished`. */
  async search(s: OfferSearch, options: { allowUnpublished?: boolean } = {}): Promise<OfferResult> {
    const { db, clock } = this.deps;
    const owner = await db.system(({ pms }) => pms.propertyOrg(s.propertyId));
    if (!owner) throw new NotFoundError('Hotel');
    const orgId = owner.organizationId;
    const key = offerQueryKey(s);
    const now = clock.now();

    const cached = await db.tenant(orgId, async (r) => {
      const property = await r.properties.get(s.propertyId);
      if (!property || (!options.allowUnpublished && property.status !== 'published'))
        throw new NotFoundError('Hotel');
      this.validateStay(property, s);
      const quotes = await r.offerQuotes.findCached(
        s.propertyId,
        key,
        new Date(now.getTime() - this.deps.cacheTtlSeconds * 1000),
      );
      return { property, quotes };
    });
    if (cached.quotes.length > 0) return { ...cached, fromCache: true };

    const offers = await this.fetchLive(orgId, cached.property, s);
    const quotes = await db.tenant(orgId, async (r) => {
      const ratePlans = await r.ratePlans.listForProperty(s.propertyId);
      const byPmsId = new Map(ratePlans.filter((rp) => rp.pmsId).map((rp) => [rp.pmsId!, rp]));
      const sellable = offers
        .map((offer) => ({ offer, ratePlan: byPmsId.get(offer.pmsRatePlanId) }))
        .filter(
          (x): x is { offer: PmsOffer; ratePlan: NonNullable<typeof x.ratePlan> } =>
            !!x.ratePlan &&
            x.ratePlan.exposedToAgents &&
            x.ratePlan.isBookable &&
            x.ratePlan.paymentMode !== null,
        );
      const expiresAt = new Date(now.getTime() + this.deps.validityMinutes * 60_000);
      return r.offerQuotes.insertMany(
        sellable.map(({ offer, ratePlan }) => ({
          propertyId: s.propertyId,
          roomTypeId: ratePlan.roomTypeId,
          ratePlanId: ratePlan.id,
          queryKey: key,
          arrival: s.checkIn,
          departure: s.checkOut,
          adults: s.adults,
          childrenAges: s.childrenAges,
          currency: offer.total.currency,
          totalAmount: offer.total.amount,
          paymentMode: ratePlan.paymentMode!,
          availableUnits: offer.availableUnits,
          details: toDetails(offer),
          expiresAt,
        })),
        now,
      );
    });
    return {
      property: cached.property,
      quotes: quotes.sort((a, b) => a.totalAmount - b.totalAmount),
      fromCache: false,
    };
  }

  /** Hotel dashboard preview: every bookable PMS offer, exposed or not. Nothing is stored. */
  async preview(orgId: string, s: OfferSearch) {
    const property = await this.deps.db.tenant(orgId, (r) => r.properties.get(s.propertyId));
    if (!property) throw new NotFoundError('Property');
    this.validateStay(property, s);
    const offers = await this.fetchLive(orgId, property, s);
    const ratePlans = await this.deps.db.tenant(orgId, (r) => r.ratePlans.listForProperty(s.propertyId));
    const byPmsId = new Map(ratePlans.filter((rp) => rp.pmsId).map((rp) => [rp.pmsId!, rp]));
    return offers.map((offer) => {
      const rp = byPmsId.get(offer.pmsRatePlanId);
      return {
        roomTypeName: offer.roomTypeName,
        ratePlanName: offer.ratePlanName,
        ratePlanId: rp?.id ?? null,
        exposedToAgents: rp?.exposedToAgents ?? false,
        paymentMode: rp?.paymentMode ?? null,
        total: toDisplayMoney(offer.total),
        availableUnits: offer.availableUnits,
        cancellation: describeCancellation(
          {
            name: offer.cancellation.name,
            freeUntil: offer.cancellation.freeUntil,
            fee: offer.cancellation.fee,
            stayPrice: offer.accommodation,
          },
          property.timeZone,
          this.deps.clock.now(),
        ),
      };
    });
  }

  private async fetchLive(orgId: string, property: PropertyRow, s: OfferSearch): Promise<PmsOffer[]> {
    if (!property.pmsPropertyId) {
      throw new UnprocessableError('not_bookable', 'This hotel is not connected to a PMS yet');
    }
    const client = await this.deps.connections.clientFor(orgId);
    return client.getOffers({
      pmsPropertyId: property.pmsPropertyId,
      arrival: s.checkIn,
      departure: s.checkOut,
      adults: s.adults,
      childrenAges: s.childrenAges,
    });
  }
}

function toDetails(offer: PmsOffer): OfferQuoteDetails {
  return {
    roomTypeName: offer.roomTypeName,
    ratePlanName: offer.ratePlanName,
    ratePlanDescription: offer.ratePlanDescription,
    pmsRatePlanId: offer.pmsRatePlanId,
    minGuarantee: offer.minGuarantee,
    accommodation: offer.accommodation,
    includedTaxes: offer.includedTaxes,
    extras: offer.extras,
    prepayment: offer.prepayment,
    nightly: offer.nightly,
    cancellation: {
      code: offer.cancellation.code,
      name: offer.cancellation.name,
      description: offer.cancellation.description,
      freeUntil: offer.cancellation.freeUntil?.toISOString() ?? null,
      fee: offer.cancellation.fee,
    },
    noShowFee: offer.noShowFee,
  };
}

/** Amount charged at checkout: prepaid rates charge the all-in total, pay-at-hotel rates nothing. */
export function dueNow(quote: Pick<OfferQuoteRow, 'paymentMode' | 'totalAmount' | 'currency'>): Money {
  return { amount: quote.paymentMode === 'prepaid' ? quote.totalAmount : 0, currency: quote.currency };
}

export function toOfferDto(
  quote: OfferQuoteRow,
  context: { timeZone: string; roomMaxOccupancy: number | null; includes: string[]; now: Date },
): OfferDto {
  const d = quote.details;
  const total: Money = { amount: quote.totalAmount, currency: quote.currency };
  const now = dueNow(quote);
  const freeUntil = d.cancellation.freeUntil ? new Date(d.cancellation.freeUntil) : null;
  return {
    offerId: quote.id,
    hotelId: quote.propertyId,
    roomType: { id: quote.roomTypeId, name: d.roomTypeName, maxOccupancy: context.roomMaxOccupancy },
    ratePlan: {
      id: quote.ratePlanId,
      name: d.ratePlanName,
      description: d.ratePlanDescription,
      includes: context.includes,
    },
    checkIn: quote.arrival,
    checkOut: quote.departure,
    nights: nightsBetween(quote.arrival, quote.departure),
    adults: quote.adults,
    childrenAges: quote.childrenAges,
    paymentMode: quote.paymentMode,
    total: toDisplayMoney(total),
    dueNow: toDisplayMoney(now),
    dueAtHotel: toDisplayMoney({ amount: total.amount - now.amount, currency: total.currency }),
    priceBreakdown: {
      accommodation: toDisplayMoney(d.accommodation),
      includedTaxes: toDisplayMoney(d.includedTaxes),
      extras: d.extras.map((e) => ({ label: e.label, amount: toDisplayMoney(e.amount) })),
      nightly: d.nightly.map((n) => ({ date: n.date, amount: toDisplayMoney(n.amount) })),
    },
    cancellationPolicy: {
      summary: describeCancellation(
        { name: d.cancellation.name, freeUntil, fee: d.cancellation.fee, stayPrice: d.accommodation },
        context.timeZone,
        context.now,
      ),
      freeCancellationUntil: freeUntil && freeUntil > context.now ? freeUntil.toISOString() : null,
      feeAfterDeadline: toDisplayMoney(d.cancellation.fee),
    },
    availableRooms: quote.availableUnits,
    expiresAt: quote.expiresAt.toISOString(),
  };
}
