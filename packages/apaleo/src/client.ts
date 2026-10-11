import type {
  CreateReservationInput,
  OfferQuery,
  PmsAccount,
  PmsClient,
  PmsOffer,
  PmsProperty,
  PmsRatePlan,
  PmsReservation,
  PmsRoomType,
  RecordPaymentInput,
} from '@lodgent/core';
import { UpstreamError } from '@lodgent/core';
import { BRAND, toMajor } from '@lodgent/shared';
import type { z } from 'zod';
import { fromGuarantee, toOffer, toProperty, toRatePlan, toReservationStatus, toRoomType } from './mapping';
import {
  AccountModel,
  BookingCreated,
  FolioList,
  PropertyList,
  RatePlanList,
  Reservation,
  StayOffers,
  SubscriptionCreated,
  UnitGroupList,
} from './schemas';

export interface ApaleoClientOptions {
  apiUrl: string;
  webhookUrl: string;
  getAccessToken: () => Promise<string>;
  /** Channel code used for offers and bookings. Rate plans must be distributed on it. */
  channelCode?: 'Ibe' | 'Direct';
  fetch?: typeof fetch;
  maxRetries?: number;
  timeoutMs?: number;
}

interface RequestOptions<T> {
  query?: Record<string, string | number | boolean | string[] | number[] | undefined>;
  body?: unknown;
  schema?: z.ZodType<T>;
  idempotencyKey?: string;
  base?: 'api' | 'webhook';
  /** Return null instead of throwing on 404. */
  allowNotFound?: boolean;
}

const RETRYABLE = new Set([429, 502, 503, 504]);

export class ApaleoClient implements PmsClient {
  private readonly fetch: typeof fetch;
  private readonly channelCode: 'Ibe' | 'Direct';

  constructor(private readonly options: ApaleoClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.channelCode = options.channelCode ?? 'Ibe';
  }

  async request<T>(method: string, path: string, opts: RequestOptions<T> = {}): Promise<T> {
    const base = opts.base === 'webhook' ? this.options.webhookUrl : this.options.apiUrl;
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value === undefined) continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    // Retry only when repeating the request is safe.
    const safeToRetry = method !== 'POST' || opts.idempotencyKey !== undefined;
    const maxRetries = safeToRetry ? (this.options.maxRetries ?? 3) : 0;

    for (let attempt = 0; ; attempt++) {
      const token = await this.options.getAccessToken();
      let res: Response;
      try {
        res = await this.fetch(url, {
          method,
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
        });
      } catch (error) {
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new UpstreamError('apaleo', `Apaleo request failed: ${method} ${path}`, {
          cause: String(error),
        });
      }

      if (RETRYABLE.has(res.status) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 10_000)
            : backoffMs(attempt),
        );
        continue;
      }
      if (res.status === 404 && opts.allowNotFound) return null as T;
      if (!res.ok) {
        const text = (await res.text()).slice(0, 500);
        throw new UpstreamError('apaleo', `Apaleo returned ${res.status} for ${method} ${path}`, {
          status: res.status,
          body: text,
        });
      }
      if (res.status === 204 || !opts.schema) return undefined as T;
      const json: unknown = await res.json();
      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) {
        throw new UpstreamError('apaleo', `Unexpected Apaleo response for ${method} ${path}`, {
          issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }
      return parsed.data;
    }
  }

  async getAccount(): Promise<PmsAccount> {
    const account = await this.request('GET', '/account/v1/accounts/current', { schema: AccountModel });
    return { accountCode: account.code, accountName: account.name ?? null };
  }

  async listProperties(): Promise<PmsProperty[]> {
    const list = await this.request('GET', '/inventory/v1/properties', {
      query: { status: ['Live', 'Test'], includeArchived: false, pageSize: 200 },
      schema: PropertyList,
    });
    return list.properties.filter((p) => !p.isArchived).map(toProperty);
  }

  async listRoomTypes(pmsPropertyId: string): Promise<PmsRoomType[]> {
    const list = await this.request('GET', '/inventory/v1/unit-groups', {
      query: { propertyId: pmsPropertyId, unitGroupTypes: ['BedRoom'], pageSize: 200 },
      schema: UnitGroupList,
    });
    return list.unitGroups.filter((u) => u.type === 'BedRoom').map(toRoomType);
  }

  async listRatePlans(pmsPropertyId: string): Promise<PmsRatePlan[]> {
    const list = await this.request('GET', '/rateplan/v1/rate-plans', {
      query: { propertyId: pmsPropertyId, includeArchived: false, pageSize: 500 },
      schema: RatePlanList,
    });
    return list.ratePlans.map(toRatePlan);
  }

  async getOffers(query: OfferQuery): Promise<PmsOffer[]> {
    const result = await this.request('GET', '/booking/v1/offers', {
      query: {
        propertyId: query.pmsPropertyId,
        arrival: query.arrival,
        departure: query.departure,
        adults: query.adults,
        childrenAges: query.childrenAges.length > 0 ? query.childrenAges : undefined,
        channelCode: this.channelCode,
        unitGroupTypes: ['BedRoom'],
        timeSliceTemplate: 'OverNight',
      },
      schema: StayOffers,
      allowNotFound: true,
    });
    return (result?.offers ?? []).map(toOffer).filter((o): o is PmsOffer => o !== null);
  }

  async createReservation(input: CreateReservationInput): Promise<PmsReservation> {
    const person = {
      firstName: input.guest.firstName,
      lastName: input.guest.lastName,
      email: input.guest.email,
      phone: input.guest.phone ?? undefined,
    };
    const created = await this.request('POST', '/booking/v1/bookings', {
      idempotencyKey: input.idempotencyKey,
      schema: BookingCreated,
      body: {
        booker: person,
        comment: input.comment,
        bookerComment: input.specialRequests ?? undefined,
        reservations: [
          {
            arrival: input.arrival,
            departure: input.departure,
            adults: input.adults,
            childrenAges: input.childrenAges.length > 0 ? input.childrenAges : undefined,
            channelCode: this.channelCode,
            source: BRAND.name,
            externalCode: input.externalCode,
            comment: input.comment,
            guestComment: input.specialRequests ?? undefined,
            primaryGuest: person,
            guaranteeType: fromGuarantee(input.guarantee),
            timeSlices: input.nightly.map((n) => ({
              ratePlanId: input.pmsRatePlanId,
              totalAmount: { amount: toMajor(n.amount), currency: n.amount.currency },
            })),
          },
        ],
      },
    });
    const reservationId = created.reservationIds[0]?.id;
    if (!reservationId) throw new UpstreamError('apaleo', 'Apaleo created a booking without a reservation');
    return {
      pmsBookingId: created.id,
      pmsReservationId: reservationId,
      confirmationNumber: reservationId,
      status: 'confirmed',
    };
  }

  async getReservation(pmsReservationId: string): Promise<PmsReservation | null> {
    const r = await this.request('GET', `/booking/v1/reservations/${encodeURIComponent(pmsReservationId)}`, {
      schema: Reservation,
      allowNotFound: true,
    });
    if (!r) return null;
    return {
      pmsBookingId: r.bookingId,
      pmsReservationId: r.id,
      confirmationNumber: r.id,
      status: toReservationStatus(r.status),
    };
  }

  async cancelReservation(pmsReservationId: string): Promise<void> {
    await this.request(
      'PUT',
      `/booking/v1/reservation-actions/${encodeURIComponent(pmsReservationId)}/cancel`,
    );
  }

  /** Posts the guest's card payment to the reservation's folio so the hotel's books reconcile. */
  async recordPayment(input: RecordPaymentInput): Promise<void> {
    const list = await this.request('GET', '/finance/v1/folios', {
      query: { reservationIds: [input.pmsReservationId] },
      schema: FolioList,
    });
    const folio = list.folios.find((f) => f.isMainFolio) ?? list.folios[0];
    if (!folio) throw new UpstreamError('apaleo', `No folio found for reservation ${input.pmsReservationId}`);
    await this.request('POST', `/finance/v1/folios/${encodeURIComponent(folio.id)}/payments`, {
      idempotencyKey: input.idempotencyKey,
      body: {
        method: 'CreditCard',
        receipt: input.reference,
        amount: { amount: toMajor(input.amount), currency: input.amount.currency },
      },
    });
  }

  async subscribeWebhooks(endpointUrl: string, pmsPropertyIds: string[]): Promise<string> {
    const created = await this.request('POST', '/v1/subscriptions', {
      base: 'webhook',
      schema: SubscriptionCreated,
      idempotencyKey: `subscribe:${endpointUrl}:${pmsPropertyIds.join(',')}`,
      body: { endpointUrl, events: ['reservation/*'], propertyIds: pmsPropertyIds },
    });
    return created.id;
  }

  async unsubscribeWebhooks(subscriptionId: string): Promise<void> {
    await this.request('DELETE', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      base: 'webhook',
      allowNotFound: true,
    });
  }
}

function backoffMs(attempt: number): number {
  return Math.min(250 * 2 ** attempt + Math.floor(Math.random() * 100), 5000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
