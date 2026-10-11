import { randomBytes, timingSafeEqual } from 'node:crypto';
import { addDays, nightsBetween, zonedDateTimeToInstant } from '@lodgent/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  FAKE_ACCOUNTS,
  type FakeAccount,
  type FakeProperty,
  type FakeRatePlan,
  type FakeUnitGroup,
} from './fixtures';

/**
 * An in-memory stand-in for Apaleo (identity, core API and webhook API) used by tests and local
 * development. It follows the request/response shapes of the real API for every endpoint the
 * adapter calls, applies realistic pricing (VAT, city tax, mandatory fees) and availability, honours
 * Idempotency-Key, and delivers webhooks.
 */

export interface FakeApaleoOptions {
  clientId?: string;
  clientSecret?: string;
  accessTokenTtlSeconds?: number;
  accounts?: FakeAccount[];
  /** Override "now" (tests). */
  now?: () => Date;
}

interface FakeReservation {
  id: string;
  bookingId: string;
  account: string;
  propertyId: string;
  ratePlanId: string;
  unitGroupId: string;
  arrival: string;
  departure: string;
  adults: number;
  childrenAges: number[];
  status: 'Confirmed' | 'InHouse' | 'CheckedOut' | 'Canceled' | 'NoShow';
  externalCode?: string;
  comment?: string;
  guarantee: string;
  primaryGuest: Record<string, unknown>;
  timeSlices: { ratePlanId: string; totalAmount?: { amount: number; currency: string } }[];
  payments: { method: string; receipt: string; amount: { amount: number; currency: string } }[];
  createdAt: string;
}

export interface FakeApaleoState {
  reservations: Map<string, FakeReservation>;
  subscriptions: Map<
    string,
    { id: string; account: string; endpointUrl: string; events: string[]; propertyIds: string[] }
  >;
  webhookDeliveries: { url: string; body: unknown; status: number | null }[];
  failNext: Map<string, number>;
  requests: { method: string; url: string; idempotencyKey?: string }[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const id = (prefix: string, bytes = 9) => `${prefix}${randomBytes(bytes).toString('base64url')}`;
const bookingCode = () => Array.from(randomBytes(8), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[b % 24]).join('');

export function createFakeApaleo(options: FakeApaleoOptions = {}) {
  const clientId = options.clientId ?? 'lodgent-fake-client';
  const clientSecret = options.clientSecret ?? 'lodgent-fake-secret';
  const accessTtl = options.accessTokenTtlSeconds ?? 3600;
  const accounts = options.accounts ?? FAKE_ACCOUNTS;
  const now = options.now ?? (() => new Date());

  const codes = new Map<string, { account: string; redirectUri: string; expiresAt: number }>();
  const accessTokens = new Map<string, { account: string; expiresAt: number }>();
  const refreshTokens = new Map<string, { account: string }>();
  const idempotency = new Map<string, { status: number; body: unknown }>();
  const state: FakeApaleoState = {
    reservations: new Map(),
    subscriptions: new Map(),
    webhookDeliveries: [],
    failNext: new Map(),
    requests: [],
  };

  const app: FastifyInstance = Fastify({ logger: false });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.addHook('onRequest', async (req) => {
    const key = req.headers['idempotency-key'];
    state.requests.push({
      method: req.method,
      url: req.url,
      idempotencyKey: typeof key === 'string' ? key : undefined,
    });
  });

  const findAccount = (code: string) => accounts.find((a) => a.code === code);
  const findProperty = (account: string, propertyId: string) =>
    findAccount(account)?.properties.find((p) => p.id === propertyId);
  const allRatePlans = (account: string) =>
    (findAccount(account)?.properties ?? []).flatMap((p) =>
      p.ratePlans.map((rp) => ({ property: p, ratePlan: rp })),
    );

  function failIfRequested(operation: string, reply: FastifyReply): boolean {
    const status = state.failNext.get(operation);
    if (status === undefined) return false;
    state.failNext.delete(operation);
    reply.status(status).send({ messages: [`Simulated ${status} for ${operation}`] });
    return true;
  }

  function authenticate(req: FastifyRequest, reply: FastifyReply): string | null {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const entry = accessTokens.get(token);
    if (!entry || entry.expiresAt < now().getTime()) {
      reply.status(401).send({ message: 'Unauthorized' });
      return null;
    }
    return entry.account;
  }

  function checkClient(req: FastifyRequest): boolean {
    const header = req.headers.authorization ?? '';
    const body = (req.body ?? {}) as Record<string, string>;
    let id = body.client_id;
    let secret = body.client_secret;
    if (header.startsWith('Basic ')) {
      const [u, p] = Buffer.from(header.slice(6), 'base64').toString().split(':');
      id = decodeURIComponent(u ?? '');
      secret = decodeURIComponent(p ?? '');
    }
    const a = Buffer.from(`${id}:${secret}`);
    const b = Buffer.from(`${clientId}:${clientSecret}`);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function issueTokens(account: string) {
    const accessToken = id('fat_');
    const refreshToken = id('frt_');
    accessTokens.set(accessToken, { account, expiresAt: now().getTime() + accessTtl * 1000 });
    refreshTokens.set(refreshToken, { account });
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: accessTtl,
      token_type: 'Bearer',
      scope: 'offline_access setup.read rates.read availability.read reservations.manage folios.manage',
    };
  }

  // ---- Identity -------------------------------------------------------------------------
  app.get('/connect/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.client_id !== clientId) return reply.status(400).send('unknown client_id');
    const options = accounts.map((a) => `<option value="${a.code}">${a.name} (${a.code})</option>`).join('');
    const hidden = ['redirect_uri', 'state']
      .map((k) => `<input type="hidden" name="${k}" value="${(q[k] ?? '').replace(/"/g, '&quot;')}">`)
      .join('');
    reply
      .type('text/html')
      .send(`<!doctype html><html><body style="font-family:system-ui;max-width:420px;margin:60px auto">
<h1>Fake Apaleo</h1><p>Lodgent is requesting access to your Apaleo account:</p><p><code>${q.scope ?? ''}</code></p>
<form method="get" action="/connect/authorize/approve">${hidden}
<label>Account <select name="account">${options}</select></label><p><button type="submit" id="approve">Allow access</button></p></form></body></html>`);
  });

  app.get('/connect/authorize/approve', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const account = findAccount(q.account ?? '') ? q.account! : accounts[0]!.code;
    const code = id('fac_');
    codes.set(code, { account, redirectUri: q.redirect_uri ?? '', expiresAt: now().getTime() + 300_000 });
    const target = new URL(q.redirect_uri ?? '');
    target.searchParams.set('code', code);
    if (q.state) target.searchParams.set('state', q.state);
    return reply.redirect(target.toString());
  });

  app.post('/connect/token', async (req, reply) => {
    if (!checkClient(req)) return reply.status(401).send({ error: 'invalid_client' });
    if (failIfRequested('token', reply)) return;
    const body = req.body as Record<string, string>;
    if (body.grant_type === 'authorization_code') {
      const entry = codes.get(body.code ?? '');
      codes.delete(body.code ?? '');
      if (!entry || entry.expiresAt < now().getTime() || entry.redirectUri !== body.redirect_uri) {
        return reply.status(400).send({ error: 'invalid_grant' });
      }
      return issueTokens(entry.account);
    }
    if (body.grant_type === 'refresh_token') {
      const entry = refreshTokens.get(body.refresh_token ?? '');
      if (!entry) return reply.status(400).send({ error: 'invalid_grant' });
      refreshTokens.delete(body.refresh_token ?? ''); // one-time use: refresh tokens rotate
      return issueTokens(entry.account);
    }
    return reply.status(400).send({ error: 'unsupported_grant_type' });
  });

  app.post('/connect/revocation', async (req, reply) => {
    const body = req.body as Record<string, string>;
    refreshTokens.delete(body.token ?? '');
    return reply.status(200).send();
  });

  // ---- Account & inventory -------------------------------------------------------------
  app.get('/account/v1/accounts/current', async (req, reply) => {
    const account = authenticate(req, reply);
    if (!account) return;
    const a = findAccount(account)!;
    return { code: a.code, name: a.name };
  });

  app.get('/inventory/v1/properties', async (req, reply) => {
    const account = authenticate(req, reply);
    if (!account) return;
    const properties = findAccount(account)!.properties.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      description: p.description,
      companyName: `${p.name} GmbH`,
      commercialRegisterEntry: 'n/a',
      taxId: 'n/a',
      location: p.location,
      paymentTerms: {},
      timeZone: p.timeZone,
      currencyCode: p.currencyCode,
      created: '2024-01-01T00:00:00Z',
      status: 'Live',
      isArchived: false,
      isTemplate: false,
    }));
    return { properties, count: properties.length };
  });

  app.get('/inventory/v1/unit-groups', async (req, reply) => {
    const account = authenticate(req, reply);
    if (!account) return;
    const { propertyId } = req.query as Record<string, string>;
    const p = findProperty(account, propertyId ?? '');
    const unitGroups = (p?.unitGroups ?? []).map((u) => ({
      id: u.id,
      code: u.code,
      name: u.name,
      description: u.description,
      memberCount: u.memberCount,
      maxPersons: u.maxPersons,
      type: 'BedRoom',
      property: { id: p!.id, code: p!.code, name: p!.name },
    }));
    return { unitGroups, count: unitGroups.length };
  });

  app.get('/rateplan/v1/rate-plans', async (req, reply) => {
    const account = authenticate(req, reply);
    if (!account) return;
    const { propertyId } = req.query as Record<string, string>;
    const p = findProperty(account, propertyId ?? '');
    const ratePlans = (p?.ratePlans ?? []).map((rp) => {
      const ug = p!.unitGroups.find((u) => u.id === rp.unitGroupId)!;
      return {
        id: rp.id,
        code: rp.code,
        name: rp.name,
        description: rp.description,
        minGuaranteeType: rp.minGuaranteeType,
        property: { id: p!.id },
        unitGroup: { id: ug.id, code: ug.code, name: ug.name },
        cancellationPolicy: {
          id: rp.cancellation.id,
          code: rp.cancellation.code,
          name: rp.cancellation.name,
          description: rp.cancellation.description,
        },
        channelCodes: rp.channelCodes,
        isBookable: true,
        isSubjectToCityTax: true,
        isDerived: false,
        derivationLevel: 0,
        accountingConfigs: [],
        timeSliceDefinition: { id: `${p!.id}-NIGHT`, name: 'Overnight', template: 'OverNight' },
        includedServices: rp.includedServicePerPerson
          ? [
              {
                service: {
                  id: `${p!.id}-${rp.includedServicePerPerson.code}`,
                  code: rp.includedServicePerPerson.code,
                  name: rp.includedServicePerPerson.name,
                  description: rp.includedServicePerPerson.description,
                },
                grossPrice: { amount: rp.includedServicePerPerson.amount, currency: p!.currencyCode },
                pricingMode: 'Included',
              },
            ]
          : [],
      };
    });
    return { ratePlans, count: ratePlans.length };
  });

  // ---- Offers --------------------------------------------------------------------------
  function bookedUnits(account: string, unitGroupId: string, night: string): number {
    let n = 0;
    for (const r of state.reservations.values()) {
      if (r.account !== account || r.unitGroupId !== unitGroupId) continue;
      if (r.status !== 'Confirmed' && r.status !== 'InHouse') continue;
      if (r.arrival <= night && night < r.departure) n++;
    }
    return n;
  }

  function nightlyGross(
    ug: FakeUnitGroup,
    rp: FakeRatePlan,
    night: string,
    adults: number,
    children: number,
  ) {
    const day = new Date(`${night}T12:00:00Z`).getUTCDay();
    const weekend = day === 5 || day === 6 ? 1.12 : 1;
    let price = ug.baseRate * rp.priceFactor * weekend;
    price += Math.max(0, adults - 2) * 25 + children * 15;
    if (rp.includedServicePerPerson) price += rp.includedServicePerPerson.amount * adults;
    return round2(price);
  }

  function buildOffer(
    account: string,
    p: FakeProperty,
    rp: FakeRatePlan,
    arrival: string,
    departure: string,
    adults: number,
    childrenAges: number[],
  ) {
    const ug = p.unitGroups.find((u) => u.id === rp.unitGroupId)!;
    const nights = nightsBetween(arrival, departure);
    if (adults + childrenAges.length > ug.maxPersons) return null;
    const dates = Array.from({ length: nights }, (_, i) => addDays(arrival, i));
    const available = Math.min(...dates.map((d) => ug.memberCount - bookedUnits(account, ug.id, d)));
    if (available <= 0) return null;
    const currency = p.currencyCode;
    const slices = dates.map((d) => ({
      from: `${d}T15:00:00+00:00`,
      to: `${addDays(d, 1)}T11:00:00+00:00`,
      availableUnits: available,
      totalGrossAmount: { amount: nightlyGross(ug, rp, d, adults, childrenAges.length), currency },
    }));
    const total = round2(slices.reduce((s, x) => s + x.totalGrossAmount.amount, 0));
    const tax = round2(total - total / (1 + p.vatPercent / 100));
    const cityTaxes = [];
    if (p.cityTax?.perAdultPerNight) {
      const taxedNights = Math.min(nights, p.cityTax.maxNights ?? nights);
      cityTaxes.push({
        id: `${p.id}-CITYTAX`,
        code: 'CITYTAX',
        name: p.cityTax.name,
        totalGrossAmount: { amount: round2(p.cityTax.perAdultPerNight * adults * taxedNights), currency },
      });
    } else if (p.cityTax?.percentOfRoom) {
      cityTaxes.push({
        id: `${p.id}-CITYTAX`,
        code: 'CITYTAX',
        name: p.cityTax.name,
        totalGrossAmount: { amount: round2((total * p.cityTax.percentOfRoom) / 100), currency },
      });
    }
    const fees = p.fee
      ? [
          {
            id: `${p.id}-${p.fee.code}`,
            code: p.fee.code,
            name: p.fee.name,
            totalAmount: {
              grossAmount: round2(p.fee.perNight * nights),
              netAmount: round2(p.fee.perNight * nights),
              vatType: 'Without',
              vatPercent: 0,
              currency,
            },
          },
        ]
      : [];
    const firstNight = slices[0]!.totalGrossAmount.amount;
    let dueDateTime: string;
    let fee: number;
    if (rp.cancellation.freeDaysBeforeArrival === null) {
      dueDateTime = now().toISOString();
      fee = total;
    } else {
      dueDateTime = zonedDateTimeToInstant(
        addDays(arrival, -rp.cancellation.freeDaysBeforeArrival),
        '18:00',
        p.timeZone,
      ).toISOString();
      fee = firstNight;
    }
    return {
      arrival: `${arrival}T15:00:00+00:00`,
      departure: `${departure}T11:00:00+00:00`,
      unitGroup: {
        id: ug.id,
        code: ug.code,
        name: ug.name,
        description: ug.description,
        maxPersons: ug.maxPersons,
        type: 'BedRoom',
      },
      ratePlan: {
        id: rp.id,
        code: rp.code,
        name: rp.name,
        description: rp.description,
        isSubjectToCityTax: true,
      },
      minGuaranteeType: rp.minGuaranteeType,
      availableUnits: available,
      totalGrossAmount: { amount: total, currency },
      prePaymentAmount: { amount: rp.minGuaranteeType === 'Prepayment' ? total : 0, currency },
      cancellationFee: {
        code: rp.cancellation.code,
        name: rp.cancellation.name,
        description: rp.cancellation.description,
        dueDateTime,
        fee: { amount: fee, currency },
      },
      noShowFee: {
        code: 'NOSHOW',
        name: 'No-show',
        description: 'First night is charged',
        fee: { amount: firstNight, currency },
      },
      timeSlices: slices,
      fees,
      cityTaxes,
      taxDetails: [
        {
          vatType: p.vatType,
          vatPercent: p.vatPercent,
          net: { amount: round2(total - tax), currency },
          tax: { amount: tax, currency },
        },
      ],
      isCorporate: false,
    };
  }

  app.get('/booking/v1/offers', async (req, reply) => {
    const account = authenticate(req, reply);
    if (!account) return;
    if (failIfRequested('offers', reply)) return;
    const q = req.query as Record<string, string>;
    const p = findProperty(account, q.propertyId ?? '');
    if (!p) return reply.status(404).send({ messages: ['Property not found'] });
    const adults = Number(q.adults ?? 1);
    const childrenAges = q.childrenAges ? q.childrenAges.split(',').map(Number) : [];
    const arrival = (q.arrival ?? '').slice(0, 10);
    const departure = (q.departure ?? '').slice(0, 10);
    if (!arrival || !departure || nightsBetween(arrival, departure) < 1) {
      return reply.status(400).send({ messages: ['Invalid dates'] });
    }
    const channel = q.channelCode;
    const offers = p.ratePlans
      .filter((rp) => !channel || rp.channelCodes.includes(channel))
      .map((rp) => buildOffer(account, p, rp, arrival, departure, adults, childrenAges))
      .filter((o) => o !== null);
    return { property: { id: p.id, code: p.code, name: p.name }, offers };
  });

  // ---- Bookings ------------------------------------------------------------------------
  function deliverWebhooks(account: string, type: string, reservation: FakeReservation) {
    for (const sub of state.subscriptions.values()) {
      if (sub.account !== account) continue;
      if (sub.propertyIds.length > 0 && !sub.propertyIds.includes(reservation.propertyId)) continue;
      const body = {
        topic: 'Reservation',
        type,
        id: reservation.id,
        accountId: account,
        propertyId: reservation.propertyId,
        timestamp: now().getTime(),
      };
      const delivery = { url: sub.endpointUrl, body, status: null as number | null };
      state.webhookDeliveries.push(delivery);
      void fetch(sub.endpointUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((r) => {
          delivery.status = r.status;
        })
        .catch(() => {
          delivery.status = 0;
        });
    }
  }

  app.post('/booking/v1/bookings', async (req, reply) => {
    const account = authenticate(req, reply);
    if (!account) return;
    const key = req.headers['idempotency-key'];
    const idemKey = typeof key === 'string' ? `${account}:${key}` : null;
    if (idemKey && idempotency.has(idemKey)) {
      const cached = idempotency.get(idemKey)!;
      return reply.status(cached.status).send(cached.body);
    }
    if (failIfRequested('createBooking', reply)) return;
    const body = req.body as {
      booker?: { lastName?: string };
      comment?: string;
      reservations?: {
        arrival: string;
        departure: string;
        adults: number;
        childrenAges?: number[];
        channelCode?: string;
        externalCode?: string;
        comment?: string;
        guaranteeType?: string;
        primaryGuest?: Record<string, unknown>;
        timeSlices?: { ratePlanId: string; totalAmount?: { amount: number; currency: string } }[];
      }[];
    };
    if (!body?.booker?.lastName || !body.reservations?.length) {
      return reply.status(400).send({ messages: ['booker.lastName and reservations are required'] });
    }
    const bookingId = bookingCode();
    const created: FakeReservation[] = [];
    for (const [index, r] of body.reservations.entries()) {
      const ratePlanId = r.timeSlices?.[0]?.ratePlanId;
      const found = allRatePlans(account).find((x) => x.ratePlan.id === ratePlanId);
      if (!found) return reply.status(422).send({ messages: [`Unknown rate plan ${ratePlanId}`] });
      const arrival = r.arrival.slice(0, 10);
      const departure = r.departure.slice(0, 10);
      const offer = buildOffer(
        account,
        found.property,
        found.ratePlan,
        arrival,
        departure,
        r.adults,
        r.childrenAges ?? [],
      );
      if (!offer) return reply.status(422).send({ messages: ['No availability for the requested stay'] });
      if ((r.timeSlices?.length ?? 0) !== nightsBetween(arrival, departure)) {
        return reply.status(422).send({ messages: ['One time slice per night is required'] });
      }
      created.push({
        id: `${bookingId}-${index + 1}`,
        bookingId,
        account,
        propertyId: found.property.id,
        ratePlanId: found.ratePlan.id,
        unitGroupId: found.ratePlan.unitGroupId,
        arrival,
        departure,
        adults: r.adults,
        childrenAges: r.childrenAges ?? [],
        status: 'Confirmed',
        externalCode: r.externalCode,
        comment: r.comment ?? body.comment,
        guarantee: r.guaranteeType ?? found.ratePlan.minGuaranteeType,
        primaryGuest: r.primaryGuest ?? {},
        timeSlices: r.timeSlices ?? [],
        payments: [],
        createdAt: now().toISOString(),
      });
    }
    for (const r of created) {
      state.reservations.set(r.id, r);
      deliverWebhooks(account, 'created', r);
    }
    const response = { id: bookingId, reservationIds: created.map((r) => ({ id: r.id })) };
    if (idemKey) idempotency.set(idemKey, { status: 201, body: response });
    return reply.status(201).send(response);
  });

  app.get('/booking/v1/reservations/:id', async (req, reply) => {
    const account = authenticate(req, reply);
    if (!account) return;
    const r = state.reservations.get((req.params as { id: string }).id);
    if (!r || r.account !== account) return reply.status(404).send({ messages: ['Not found'] });
    return {
      id: r.id,
      bookingId: r.bookingId,
      status: r.status,
      property: { id: r.propertyId },
      ratePlan: { id: r.ratePlanId },
      arrival: r.arrival,
      departure: r.departure,
      adults: r.adults,
      externalCode: r.externalCode,
      primaryGuest: r.primaryGuest,
    };
  });

  app.put('/booking/v1/reservation-actions/:id/cancel', async (req, reply) => {
    const account = authenticate(req, reply);
    if (!account) return;
    if (failIfRequested('cancel', reply)) return;
    const r = state.reservations.get((req.params as { id: string }).id);
    if (!r || r.account !== account) return reply.status(404).send({ messages: ['Not found'] });
    if (r.status !== 'Canceled') {
      r.status = 'Canceled';
      deliverWebhooks(account, 'canceled', r);
    }
    return reply.status(204).send();
  });

  app.get('/finance/v1/folios', async (req, reply) => {
    const account = authenticate(req, reply);
    if (!account) return;
    const ids = ((req.query as Record<string, string>).reservationIds ?? '').split(',').filter(Boolean);
    const folios = ids
      .map((rid) => state.reservations.get(rid))
      .filter((r): r is FakeReservation => !!r && r.account === account)
      .map((r) => ({ id: `${r.id}-F1`, isMainFolio: true, type: 'Guest', reservation: { id: r.id } }));
    return { folios, count: folios.length };
  });

  app.post('/finance/v1/folios/:folioId/payments', async (req, reply) => {
    const account = authenticate(req, reply);
    if (!account) return;
    const key = req.headers['idempotency-key'];
    const idemKey = typeof key === 'string' ? `${account}:pay:${key}` : null;
    if (idemKey && idempotency.has(idemKey)) return reply.status(201).send(idempotency.get(idemKey)!.body);
    const folioId = (req.params as { folioId: string }).folioId;
    const r = state.reservations.get(folioId.replace(/-F1$/, ''));
    if (!r || r.account !== account) return reply.status(404).send({ messages: ['Folio not found'] });
    const body = req.body as FakeReservation['payments'][number];
    r.payments.push({ method: body.method, receipt: body.receipt, amount: body.amount });
    const response = { id: id('PAY-', 6) };
    if (idemKey) idempotency.set(idemKey, { status: 201, body: response });
    return reply.status(201).send(response);
  });

  // ---- Webhook API (webhook.apaleo.com) ------------------------------------------------
  app.post('/v1/subscriptions', async (req, reply) => {
    const account = authenticate(req, reply);
    if (!account) return;
    if (failIfRequested('subscribe', reply)) return;
    const body = req.body as { endpointUrl: string; events: string[]; propertyIds?: string[] };
    const subId = id('sub_', 6);
    state.subscriptions.set(subId, {
      id: subId,
      account,
      endpointUrl: body.endpointUrl,
      events: body.events,
      propertyIds: body.propertyIds ?? [],
    });
    return reply.status(201).send({ id: subId });
  });

  app.delete('/v1/subscriptions/:id', async (req, reply) => {
    const account = authenticate(req, reply);
    if (!account) return;
    state.subscriptions.delete((req.params as { id: string }).id);
    return reply.status(204).send();
  });

  // ---- Test controls -------------------------------------------------------------------
  app.post('/_fake/fail-next', async (req) => {
    const { operation, status } = req.body as { operation: string; status?: number };
    state.failNext.set(operation, status ?? 500);
    return { ok: true };
  });
  app.post('/_fake/reset', async () => {
    state.reservations.clear();
    state.subscriptions.clear();
    state.webhookDeliveries.length = 0;
    state.failNext.clear();
    state.requests.length = 0;
    idempotency.clear();
    return { ok: true };
  });
  app.get('/_fake/reservations', async () => ({ reservations: [...state.reservations.values()] }));
  app.get('/_fake/health', async () => ({ ok: true }));

  return {
    app,
    state,
    /** Expire every access token now (tests token refresh). */
    expireAccessTokens() {
      for (const entry of accessTokens.values()) entry.expiresAt = 0;
    },
    /** Issue tokens directly, skipping the browser consent step (tests). */
    issueTokens,
  };
}

export type FakeApaleo = ReturnType<typeof createFakeApaleo>;
