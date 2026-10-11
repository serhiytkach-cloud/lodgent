import { randomUUID } from 'node:crypto';
import {
  bookingFee,
  type Clock,
  ConflictError,
  completeness,
  DomainError,
  describeCancellation,
  destinationMatches,
  type EmbeddingModel,
  effectiveAssignments,
  haversineKm,
  NotFoundError,
  type RankCandidate,
  type Requirement,
  rankHotels,
  UpstreamError,
  ValidationError,
} from '@lodgent/core';
import type { CatalogProperty, Database, HoldRow, PropertyRow } from '@lodgent/db';
import {
  fromMajor,
  type GetOffersInput,
  type HoldDto,
  type HotelSummaryDto,
  nightsBetween,
  type OfferDto,
  type SearchHotelsInput,
  type SearchHotelsResult,
  toDisplayMoney,
} from '@lodgent/shared';
import { ATTRIBUTES, displayValue, interpretRequirement } from '@lodgent/taxonomy';
import type { Logger } from 'pino';
import type { Signer } from '../infra/signing';
import { type AgentCaller, type AgentLog, redactForLog } from './agent-log';
import type { CatalogService } from './catalog';
import { dueNow, type OfferService, toOfferDto } from './offers';

const COUNTRY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });
/** Hotels priced live per search (the rest are ranked without price). */
const PRICED_CANDIDATES = 12;
const PRICE_CONCURRENCY = 4;
const CHECKOUT_TOKEN_TTL_SECONDS = 14 * 24 * 3600;

function countryName(code: string | null): string | null {
  if (!code) return null;
  try {
    return COUNTRY_NAMES.of(code.toUpperCase()) ?? null;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

function truthy(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false && value !== 'none';
}

function summarize(text: string | null, max = 280): string | null {
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '));
  return end > max * 0.5 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

/**
 * Everything AI agents can do: search published hotels, read a profile, get live offers, hold a
 * room and follow the hold. The MCP tools and the REST endpoints are thin wrappers around this.
 */
export class AgentService {
  constructor(
    private readonly deps: {
      db: Database;
      clock: Clock;
      embeddings: EmbeddingModel;
      offers: OfferService;
      catalog: CatalogService;
      signer: Signer;
      log: AgentLog;
      logger: Logger;
      webBaseUrl: string;
      holdTtlMinutes: number;
      offerCacheTtlSeconds: number;
    },
  ) {}

  // ---- search ------------------------------------------------------------------------------

  async search(caller: AgentCaller, input: SearchHotelsInput): Promise<SearchHotelsResult> {
    const { db, clock, embeddings } = this.deps;
    const started = clock.now().getTime();
    const hasDates = !!input.checkIn || !!input.checkOut;
    if (hasDates && (!input.checkIn || !input.checkOut)) {
      throw new ValidationError('Give both checkIn and checkOut, or neither');
    }
    if (input.checkIn && input.checkOut) {
      const nights = nightsBetween(input.checkIn, input.checkOut);
      if (nights < 1) throw new ValidationError('checkOut must be after checkIn');
      if (nights > 30) throw new ValidationError('Stays are limited to 30 nights');
    }
    const partySize = input.adults + input.childrenAges.length;
    const notes: string[] = [];

    const interpret = (phrases: string[]) => {
      const matched: (Requirement & { input: string })[] = [];
      const unmatched: string[] = [];
      for (const phrase of phrases) {
        const r = interpretRequirement(phrase);
        if (r)
          matched.push({
            input: phrase,
            label: r.label,
            codes: r.codes,
            ...(r.value !== undefined ? { value: r.value } : {}),
          });
        else unmatched.push(phrase);
      }
      return { matched, unmatched };
    };
    const must = interpret(input.mustHave);
    const nice = interpret(input.niceToHave);
    const treatedAsPreferences = [...must.unmatched, ...nice.unmatched];
    const preferenceText = [input.preferences, ...treatedAsPreferences].filter(Boolean).join('; ') || null;

    // 1. Published hotels in the destination.
    const published = await db.system(({ catalog }) => catalog.publishedProperties());
    const inArea = published.flatMap((p): { p: CatalogProperty; distanceKm: number | null }[] => {
      if (input.near) {
        if (p.latitude === null || p.longitude === null) return [];
        const distanceKm = haversineKm(input.near, { latitude: p.latitude, longitude: p.longitude });
        return distanceKm <= input.near.radiusKm ? [{ p, distanceKm }] : [];
      }
      if (input.destination) {
        const place = {
          city: p.city,
          region: p.region,
          countryCode: p.countryCode,
          countryName: countryName(p.countryCode),
          hotelName: p.name,
        };
        return destinationMatches(input.destination, place) ? [{ p, distanceKm: null }] : [];
      }
      return [{ p, distanceKm: null }];
    });
    if (!input.destination && !input.near)
      notes.push('No destination given: searched every published hotel.');

    // 2. Profiles (approved values only) and sellable rooms.
    const ids = inArea.map((x) => x.p.id);
    const [assignments, rooms] = await db.system(async ({ catalog }) => [
      await catalog.approvedAssignments(ids),
      await catalog.sellableRooms(ids),
    ]);
    const similarity =
      preferenceText && ids.length > 0
        ? await embeddings
            .embed([preferenceText], 'query')
            .then(([vector]) => db.system(({ catalog }) => catalog.similarity(ids, vector!, embeddings.name)))
            .catch((error: unknown) => {
              this.deps.logger.warn({ err: error }, 'preference embedding failed; ranking without it');
              notes.push('Semantic matching was unavailable for this search.');
              return new Map<string, number>();
            })
        : null;

    const candidates: (RankCandidate & { property: CatalogProperty })[] = inArea.map(({ p, distanceKm }) => {
      const effective = [...effectiveAssignments(assignments.filter((a) => a.propertyId === p.id)).values()];
      const valuesFor = (roomTypeId: string | null) =>
        Object.fromEntries(
          effective
            .filter((a) => a.roomTypeId === roomTypeId)
            .map((a) => [a.attributeCode, a.value as boolean | number | string]),
        );
      const propertyRooms = rooms.filter((r) => r.propertyId === p.id);
      const score = completeness({
        description: p.description,
        photos: p.photos,
        hasCoordinates: p.latitude !== null && p.longitude !== null,
        hasCheckInOut: p.hasCheckInOut,
        websiteUrl: p.websiteUrl,
        roomTypes: propertyRooms.map((r) => ({ name: r.name, description: r.description })),
        exposedRatePlans: propertyRooms.reduce((n, r) => n + r.sellablePlans, 0),
        attributes: ATTRIBUTES.map((a) => ({
          code: a.code,
          label: a.label,
          importance: a.importance,
          appliesTo: a.appliesTo,
        })),
        answeredCodes: new Set(effective.filter((a) => a.roomTypeId === null).map((a) => a.attributeCode)),
      }).score;
      return {
        property: p,
        hotelId: p.id,
        name: p.name,
        completeness: score,
        attributes: valuesFor(null),
        rooms: propertyRooms.map((r) => ({
          id: r.id,
          name: r.name,
          maxOccupancy: r.maxOccupancy,
          attributes: valuesFor(r.id),
        })),
        similarity: similarity ? (similarity.get(p.id) ?? 0) : null,
        distanceKm,
      };
    });

    const query = {
      mustHave: must.matched,
      niceToHave: nice.matched,
      partySize,
      budgetPerNight: input.budgetPerNight
        ? fromMajor(input.budgetPerNight.amount, input.budgetPerNight.currency)
        : null,
    };

    // 3. Rank without prices, then price the best few live and rank again.
    let { ranked, excluded } = rankHotels(candidates, query, { preferencesText: preferenceText });
    const cheapest = new Map<string, OfferDto>();
    if (input.checkIn && input.checkOut) {
      const toPrice = ranked
        .slice(0, PRICED_CANDIDATES)
        .map((r) => candidates.find((c) => c.hotelId === r.hotelId)!);
      let failures = 0;
      const priced = await mapLimit(toPrice, PRICE_CONCURRENCY, async (c) => {
        try {
          const offers = await this.offerDtos(c.hotelId, {
            hotelId: c.hotelId,
            checkIn: input.checkIn!,
            checkOut: input.checkOut!,
            adults: input.adults,
            childrenAges: input.childrenAges,
          });
          const best = offers.offers.sort((a, b) => a.total.amount - b.total.amount)[0];
          if (best) cheapest.set(c.hotelId, best);
          return {
            ...c,
            price: best
              ? {
                  total: best.total.amount,
                  perNight: Math.round(best.total.amount / best.nights),
                  nights: best.nights,
                  currency: best.total.currency,
                }
              : null,
          };
        } catch (error) {
          if (!(error instanceof DomainError)) throw error;
          if (error instanceof UpstreamError) failures++;
          return { ...c, price: null };
        }
      });
      if (failures > 0)
        notes.push(`Live prices were unavailable for ${failures} hotel(s); they are left out.`);
      const second = rankHotels(priced, query, { preferencesText: preferenceText });
      ranked = second.ranked;
      excluded = [...excluded, ...second.excluded];
      if (ranked.length === 0 && second.excluded.length > 0) {
        notes.push(
          'No matching hotel has availability for these dates. Try other dates or fewer requirements.',
        );
      }
    }

    const results: HotelSummaryDto[] = ranked.slice(0, input.limit).map((r, i) => {
      const c = candidates.find((x) => x.hotelId === r.hotelId)!;
      const offer = cheapest.get(r.hotelId);
      // Lead with what the hotel itself confirmed, beyond what was asked for.
      const mentioned = new Set([...r.matched.mustHave, ...r.matched.niceToHave]);
      const highlights = ATTRIBUTES.filter(
        (a) => a.importance >= 3 && !mentioned.has(a.code) && truthy(c.attributes[a.code]),
      )
        .sort((a, b) => b.importance - a.importance)
        .slice(0, 4)
        .map((a) => {
          const value = c.attributes[a.code]!;
          return typeof value === 'boolean' ? a.label : `${a.label}: ${displayValue(a, value)}`;
        });
      const why = highlights.length > 0 ? [...r.why, `Highlights: ${highlights.join(', ')}`] : r.why;
      return {
        hotelId: c.hotelId,
        name: c.name,
        summary: summarize(c.property.description),
        location: {
          city: c.property.city,
          region: c.property.region,
          countryCode: c.property.countryCode,
          latitude: c.property.latitude,
          longitude: c.property.longitude,
        },
        profileUrl: `${this.deps.webBaseUrl}/hotels/${c.property.slug}`,
        rank: i + 1,
        score: r.score,
        why,
        matched: { mustHave: r.matched.mustHave, niceToHave: r.matched.niceToHave },
        cheapestOffer: offer
          ? {
              offerId: offer.offerId,
              roomType: offer.roomType.name,
              ratePlan: offer.ratePlan.name,
              includes: offer.ratePlan.includes,
              total: offer.total,
              perNight: toDisplayMoney({
                amount: Math.round(offer.total.amount / offer.nights),
                currency: offer.total.currency,
              }),
              paymentMode: offer.paymentMode,
              cancellation: offer.cancellationPolicy.summary,
              expiresAt: offer.expiresAt,
            }
          : null,
      };
    });
    if (inArea.length === 0) {
      notes.push(
        input.destination
          ? `No published hotels match “${input.destination}” yet.`
          : 'No published hotels in this area yet.',
      );
    }

    const queryId = await this.deps.log.record(
      caller,
      {
        tool: 'search_hotels',
        destination: input.near
          ? `near ${input.near.latitude.toFixed(1)},${input.near.longitude.toFixed(1)}`
          : (input.destination ?? null),
        checkIn: input.checkIn ?? null,
        checkOut: input.checkOut ?? null,
        adults: input.adults,
        children: input.childrenAges.length,
        mustHaveCodes: must.matched.flatMap((m) => m.codes),
        niceToHaveCodes: nice.matched.flatMap((m) => m.codes),
        hasPreferences: !!preferenceText,
        resultCount: results.length,
        latencyMs: clock.now().getTime() - started,
      },
      results.map((r) => ({
        organizationId: candidates.find((c) => c.hotelId === r.hotelId)!.property.organizationId,
        propertyId: r.hotelId,
        kind: 'search_impression' as const,
        rank: r.rank,
      })),
    );

    return {
      searchId: queryId ?? randomUUID(),
      results,
      interpreted: {
        mustHave: must.matched.map(({ input: i, label, codes }) => ({ input: i, label, codes })),
        niceToHave: nice.matched.map(({ input: i, label, codes }) => ({ input: i, label, codes })),
        treatedAsPreferences,
      },
      excludedCount: excluded.length,
      notes,
    };
  }

  // ---- hotel and offers ----------------------------------------------------------------------

  async hotel(caller: AgentCaller, idOrSlug: string) {
    const { profile } = await this.deps.catalog.publicProfile(idOrSlug);
    const owner = await this.deps.db.system(({ catalog }) => catalog.publishedPropertyOwner(profile.hotelId));
    await this.deps.log.record(
      caller,
      { tool: 'get_hotel', resultCount: 1 },
      owner
        ? [{ organizationId: owner.organizationId, propertyId: profile.hotelId, kind: 'hotel_view' }]
        : [],
    );
    return { hotel: profile };
  }

  async offers(caller: AgentCaller, input: GetOffersInput) {
    const started = this.deps.clock.now().getTime();
    const result = await this.offerDtos(input.hotelId, input);
    await this.deps.log.record(
      caller,
      {
        tool: 'get_offers',
        checkIn: input.checkIn,
        checkOut: input.checkOut,
        adults: input.adults,
        children: input.childrenAges.length,
        resultCount: result.offers.length,
        latencyMs: this.deps.clock.now().getTime() - started,
      },
      [{ organizationId: result.organizationId, propertyId: input.hotelId, kind: 'offers_view' }],
    );
    const { organizationId: _org, ...dto } = result;
    return dto;
  }

  /** Live offers as agent DTOs (only published hotels and rate plans the hotel sells via agents). */
  private async offerDtos(hotelId: string, input: GetOffersInput) {
    const { db, clock, offers } = this.deps;
    const result = await offers.search({
      propertyId: hotelId,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      adults: input.adults,
      childrenAges: input.childrenAges,
    });
    const orgId = result.property.organizationId;
    const context = await db.tenant(orgId, async (r) => ({
      roomTypes: await r.roomTypes.listForProperty(hotelId),
      ratePlans: await r.ratePlans.listForProperty(hotelId),
    }));
    const now = clock.now();
    const dtos = result.quotes.map((q) =>
      toOfferDto(q, {
        timeZone: result.property.timeZone,
        roomMaxOccupancy: context.roomTypes.find((rt) => rt.id === q.roomTypeId)?.maxOccupancy ?? null,
        includes:
          context.ratePlans.find((rp) => rp.id === q.ratePlanId)?.includedServices.map((s) => s.name) ?? [],
        now,
      }),
    );
    const notes: string[] = [];
    if (dtos.length === 0) notes.push('No availability for these dates and party size.');
    else
      notes.push(
        'Prices are all-in totals for the whole stay. Pass an offerId to create_hold to reserve it.',
      );
    return { organizationId: orgId, hotelId, hotelName: result.property.name, offers: dtos, notes };
  }

  // ---- holds ---------------------------------------------------------------------------------

  async createHold(caller: AgentCaller, offerId: string): Promise<HoldDto> {
    const { db, clock, offers } = this.deps;
    const owner = await db.system(({ pms }) => pms.offerQuoteOrg(offerId));
    if (!owner) throw new NotFoundError('Offer');
    const orgId = owner.organizationId;
    const now = clock.now();

    const loaded = await db.tenant(orgId, async (r) => ({
      quote: await r.offerQuotes.get(offerId),
      property: await r.properties.get(owner.propertyId),
    }));
    const property = loaded.property;
    let quote = loaded.quote;
    if (!quote || !property || property.status !== 'published') throw new NotFoundError('Offer');
    if (quote.expiresAt <= now) {
      throw new ConflictError(
        'offer_expired',
        'This offer has expired. Call get_offers again for current prices.',
      );
    }

    // Prices move: an offer older than the cache window is re-checked against the PMS.
    if (now.getTime() - quote.createdAt.getTime() > this.deps.offerCacheTtlSeconds * 1000) {
      const fresh = await offers.search({
        propertyId: quote.propertyId,
        checkIn: quote.arrival,
        checkOut: quote.departure,
        adults: quote.adults,
        childrenAges: quote.childrenAges,
      });
      const original = quote;
      const match = fresh.quotes.find(
        (q) => q.ratePlanId === original.ratePlanId && q.roomTypeId === original.roomTypeId,
      );
      if (!match) {
        throw new ConflictError(
          'offer_unavailable',
          'This room is no longer available for these dates. Call get_offers for alternatives.',
        );
      }
      if (match.totalAmount !== original.totalAmount || match.currency !== original.currency) {
        const was = toDisplayMoney({ amount: original.totalAmount, currency: original.currency }).formatted;
        const current = toDisplayMoney({ amount: match.totalAmount, currency: match.currency }).formatted;
        throw new ConflictError(
          'price_changed',
          `The price changed from ${was} to ${current}. Confirm the new price with the traveller, then call create_hold with offerId ${match.id}.`,
          {
            newOfferId: match.id,
            newTotal: toDisplayMoney({ amount: match.totalAmount, currency: match.currency }),
          },
        );
      }
      quote = match;
    }

    const finalQuote = quote;
    const hold = await db.tenant(orgId, async (r) => {
      const ratePlan = await r.ratePlans.get(finalQuote.ratePlanId);
      if (!ratePlan?.exposedToAgents || !ratePlan.isBookable || ratePlan.paymentMode === null) {
        throw new ConflictError(
          'offer_unavailable',
          'This rate is no longer sold via agents. Call get_offers again.',
        );
      }
      await r.holds.lockRoomType(finalQuote.roomTypeId);
      const competing = await r.holds.countActiveOverlapping(
        finalQuote.roomTypeId,
        finalQuote.arrival,
        finalQuote.departure,
        now,
      );
      if (competing >= finalQuote.availableUnits) {
        throw new ConflictError(
          'offer_unavailable',
          'The last rooms of this type are held by other guests right now. Call get_offers for alternatives.',
        );
      }
      const total = { amount: finalQuote.totalAmount, currency: finalQuote.currency };
      return r.holds.create({
        propertyId: finalQuote.propertyId,
        offerQuoteId: finalQuote.id,
        roomTypeId: finalQuote.roomTypeId,
        ratePlanId: finalQuote.ratePlanId,
        agentClientId: caller.partnerId,
        channel: caller.channel,
        // Masked like on funnel events, so the per-agent funnel joins holds and events on the same label.
        clientName: redactForLog(caller.clientName),
        arrival: finalQuote.arrival,
        departure: finalQuote.departure,
        adults: finalQuote.adults,
        childrenAges: finalQuote.childrenAges,
        currency: finalQuote.currency,
        totalAmount: finalQuote.totalAmount,
        dueNowAmount: dueNow(finalQuote).amount,
        paymentMode: finalQuote.paymentMode,
        feeBps: property.feeBps,
        feeAmount: bookingFee(total, property.feeBps).amount,
        offer: finalQuote.details,
        expiresAt: new Date(now.getTime() + this.deps.holdTtlMinutes * 60_000),
      });
    });

    await this.deps.log.record(
      caller,
      {
        tool: 'create_hold',
        checkIn: hold.arrival,
        checkOut: hold.departure,
        adults: hold.adults,
        children: hold.childrenAges.length,
        resultCount: 1,
      },
      [{ organizationId: orgId, propertyId: hold.propertyId, kind: 'hold_created' }],
    );
    return this.toHoldDto(hold, property);
  }

  async holdStatus(_caller: AgentCaller, holdId: string): Promise<HoldDto> {
    const { db, clock } = this.deps;
    const owner = await db.system(({ holds }) => holds.owner(holdId));
    if (!owner) throw new NotFoundError('Hold');
    const { hold, property, booking } = await db.tenant(owner.organizationId, async (r) => {
      let row = await r.holds.get(holdId);
      const booking = await r.bookings.byHold(holdId);
      // A guest who is mid-payment keeps the hold; the reconciliation job closes abandoned ones.
      if (row?.status === 'active' && row.expiresAt <= clock.now() && !booking) {
        row = (await r.holds.setStatus(holdId, 'expired', 'Checkout not completed in time')) ?? row;
      }
      return { hold: row, property: await r.properties.get(owner.propertyId), booking };
    });
    if (!hold || !property) throw new NotFoundError('Hold');
    return this.toHoldDto(hold, property, booking?.confirmationNumber ?? null);
  }

  /** Signed, unguessable checkout link for a hold. */
  checkoutUrl(holdId: string): string {
    const token = this.deps.signer.sign(
      'checkout',
      { h: holdId },
      CHECKOUT_TOKEN_TTL_SECONDS,
      this.deps.clock.now(),
    );
    return `${this.deps.webBaseUrl}/checkout/${token}`;
  }

  /** Resolves a checkout token to its hold id (null if forged or expired). */
  holdIdFromCheckoutToken(token: string): string | null {
    const payload = this.deps.signer.verify<{ h?: unknown }>('checkout', token, this.deps.clock.now());
    return typeof payload?.h === 'string' ? payload.h : null;
  }

  private toHoldDto(hold: HoldRow, property: PropertyRow, confirmationNumber: string | null = null): HoldDto {
    const total = { amount: hold.totalAmount, currency: hold.currency };
    const due = { amount: hold.dueNowAmount, currency: hold.currency };
    const active = hold.status === 'active';
    const freeUntil = hold.offer.cancellation.freeUntil ? new Date(hold.offer.cancellation.freeUntil) : null;
    const cancellation = describeCancellation(
      {
        name: hold.offer.cancellation.name,
        freeUntil,
        fee: hold.offer.cancellation.fee,
        stayPrice: hold.offer.accommodation,
      },
      property.timeZone,
      this.deps.clock.now(),
    );
    const nextStep = {
      active: `Send the traveller the checkout link. They review the stay (${cancellation}), enter their details and ${
        hold.paymentMode === 'prepaid' ? 'pay' : 'guarantee the booking with a card'
      } on a secure page before ${hold.expiresAt.toISOString()}. Never collect card details yourself.`,
      processing: 'Payment received; the hotel reservation is being created. Check again in a few seconds.',
      confirmed: `Booked${confirmationNumber ? `, confirmation number ${confirmationNumber}` : ''}. The guest receives a confirmation email.`,
      failed: `The booking could not be completed${hold.statusReason ? `: ${hold.statusReason}` : ''}. Any payment authorization was released. Search again for alternatives.`,
      expired:
        'The hold expired before checkout was completed. Call get_offers again if the traveller still wants to book.',
      cancelled: 'The hold was cancelled. Call get_offers again if the traveller still wants to book.',
    }[hold.status];
    return {
      holdId: hold.id,
      status: hold.status,
      expiresAt: hold.expiresAt.toISOString(),
      checkoutUrl: active ? this.checkoutUrl(hold.id) : null,
      hotel: { id: property.id, name: property.name },
      roomType: hold.offer.roomTypeName,
      ratePlan: hold.offer.ratePlanName,
      checkIn: hold.arrival,
      checkOut: hold.departure,
      adults: hold.adults,
      childrenAges: hold.childrenAges,
      paymentMode: hold.paymentMode,
      total: toDisplayMoney(total),
      dueNow: toDisplayMoney(due),
      dueAtHotel: toDisplayMoney({ amount: total.amount - due.amount, currency: total.currency }),
      booking: hold.status === 'confirmed' && confirmationNumber ? { confirmationNumber } : null,
      nextStep,
    };
  }
}
