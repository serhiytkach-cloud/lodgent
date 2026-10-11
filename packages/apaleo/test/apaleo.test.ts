import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { addDays, localDateAt, zonedDateTimeToInstant } from '@lodgent/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApaleoProvider } from '../src';
import { createFakeApaleo, type FakeApaleo } from '../src/fake/server';

let fake: FakeApaleo;
let base: string;
let provider: ApaleoProvider;
let accessToken: string;
const redirectUri = 'http://localhost:4000/v1/integrations/apaleo/callback';

// A stay comfortably in the future, Tuesday→Friday nights (no weekend uplift).
const arrival = (() => {
  let d = addDays(localDateAt(new Date(), 'UTC'), 30);
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 2) d = addDays(d, 1);
  return d;
})();
const departure = addDays(arrival, 3);

beforeAll(async () => {
  fake = createFakeApaleo();
  await fake.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(fake.app.server.address() as AddressInfo).port}`;
  provider = new ApaleoProvider({
    clientId: 'lodgent-fake-client',
    clientSecret: 'lodgent-fake-secret',
    identityUrl: base,
    apiUrl: base,
    webhookUrl: base,
  });
});

afterAll(async () => {
  await fake.app.close();
});

async function connect(account = 'DEMO') {
  const authorize = new URL(provider.authorizeUrl('state-123', redirectUri));
  expect(authorize.pathname).toBe('/connect/authorize');
  expect(authorize.searchParams.get('scope')).toContain('reservations.manage');
  const approve = await fetch(
    `${base}/connect/authorize/approve?${new URLSearchParams({ redirect_uri: redirectUri, state: 'state-123', account })}`,
    { redirect: 'manual' },
  );
  const location = new URL(approve.headers.get('location')!);
  expect(location.searchParams.get('state')).toBe('state-123');
  return provider.exchangeCode(location.searchParams.get('code')!, redirectUri);
}

function client() {
  return provider.client(async () => accessToken);
}

beforeEach(async () => {
  await fetch(`${base}/_fake/reset`, { method: 'POST' });
  accessToken = (await connect()).accessToken;
});

describe('OAuth', () => {
  it('exchanges a code and rotates refresh tokens', async () => {
    const tokens = await connect();
    expect(tokens.refreshToken).toMatch(/^frt_/);
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const refreshed = await provider.refresh(tokens.refreshToken!);
    expect(refreshed.accessToken).not.toBe(tokens.accessToken);
    await expect(provider.refresh(tokens.refreshToken!)).rejects.toThrow(/400/);
  });

  it('rejects a reused authorization code', async () => {
    const approve = await fetch(
      `${base}/connect/authorize/approve?${new URLSearchParams({ redirect_uri: redirectUri, state: 's' })}`,
      { redirect: 'manual' },
    );
    const code = new URL(approve.headers.get('location')!).searchParams.get('code')!;
    await provider.exchangeCode(code, redirectUri);
    await expect(provider.exchangeCode(code, redirectUri)).rejects.toThrow(/invalid_grant|400/);
  });
});

describe('inventory sync data', () => {
  it('maps properties, room types and rate plans', async () => {
    const c = client();
    expect((await c.getAccount()).accountCode).toBe('DEMO');
    const properties = await c.listProperties();
    expect(properties.map((p) => p.pmsId)).toEqual(['LIS', 'SEE', 'CHS']);
    const lisbon = properties[0]!;
    expect(lisbon).toMatchObject({ timeZone: 'Europe/Lisbon', currency: 'EUR', isLive: true });
    expect(lisbon.address.city).toBe('Lisboa');

    const rooms = await c.listRoomTypes('LIS');
    expect(rooms.map((r) => r.name)).toContain('Deluxe River View');
    const plans = await c.listRatePlans('LIS');
    const corp = plans.find((p) => p.code === 'CORP')!;
    expect(corp.minGuarantee).toBe('company');
    const bb = plans.find((p) => p.code === 'BB')!;
    expect(bb.includedServices[0]?.name).toBe('Breakfast');
    expect(bb.cancellationPolicy?.code).toBe('FLEX48');
  });
});

describe('offers', () => {
  it('returns all-in prices with taxes, city tax and the cancellation deadline', async () => {
    const offers = await client().getOffers({
      pmsPropertyId: 'LIS',
      arrival,
      departure,
      adults: 2,
      childrenAges: [],
    });
    // Corporate rates are not distributed on the IBE channel.
    expect(offers.some((o) => o.ratePlanName === 'Corporate rate')).toBe(false);
    const flex = offers.find((o) => o.pmsRatePlanId === 'LIS-CLS-FLEX')!;
    expect(flex.accommodation).toEqual({ amount: 3 * 14500, currency: 'EUR' });
    expect(flex.extras).toEqual([{ label: 'Lisbon tourist tax', amount: { amount: 2400, currency: 'EUR' } }]);
    expect(flex.total.amount).toBe(43500 + 2400);
    expect(flex.includedTaxes.amount).toBe(Math.round(43500 - 43500 / 1.06));
    expect(flex.nightly).toHaveLength(3);
    expect(flex.minGuarantee).toBe('credit_card');
    expect(flex.prepayment.amount).toBe(0);
    expect(flex.cancellation.freeUntil?.toISOString()).toBe(
      zonedDateTimeToInstant(addDays(arrival, -2), '18:00', 'Europe/Lisbon').toISOString(),
    );

    const nrf = offers.find((o) => o.pmsRatePlanId === 'LIS-CLS-NRF')!;
    expect(nrf.minGuarantee).toBe('prepayment');
    expect(nrf.prepayment).toEqual(nrf.accommodation);
  });

  it('includes mandatory fees for US hotels so the total is all-in', async () => {
    const offers = await client().getOffers({
      pmsPropertyId: 'CHS',
      arrival,
      departure,
      adults: 2,
      childrenAges: [],
    });
    const king = offers.find((o) => o.pmsRatePlanId === 'CHS-KNG-FLEX')!;
    expect(king.total.currency).toBe('USD');
    const labels = king.extras.map((e) => e.label);
    expect(labels).toEqual(['State & local accommodations tax', 'Destination fee']);
    const extras = king.extras.reduce((s, e) => s + e.amount.amount, 0);
    expect(king.total.amount).toBe(king.accommodation.amount + extras);
    expect(king.extras[1]!.amount.amount).toBe(9000);
  });

  it('respects room capacity', async () => {
    const offers = await client().getOffers({
      pmsPropertyId: 'LIS',
      arrival,
      departure,
      adults: 3,
      childrenAges: [5],
    });
    expect(new Set(offers.map((o) => o.pmsRoomTypeId))).toEqual(new Set(['LIS-SUI']));
  });

  it('retries transient failures', async () => {
    await fetch(`${base}/_fake/fail-next`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'offers', status: 503 }),
    });
    const offers = await client().getOffers({
      pmsPropertyId: 'SEE',
      arrival,
      departure,
      adults: 2,
      childrenAges: [],
    });
    expect(offers.length).toBeGreaterThan(0);
  });
});

describe('reservations', () => {
  async function book(key: string) {
    const c = client();
    const offers = await c.getOffers({
      pmsPropertyId: 'LIS',
      arrival,
      departure,
      adults: 2,
      childrenAges: [],
    });
    const offer = offers.find((o) => o.pmsRatePlanId === 'LIS-SUI-NRF')!;
    return {
      offer,
      reservation: await c.createReservation({
        pmsPropertyId: 'LIS',
        pmsRatePlanId: offer.pmsRatePlanId,
        arrival,
        departure,
        adults: 2,
        childrenAges: [],
        guest: { firstName: 'Ana', lastName: 'Silva', email: 'ana@example.com', phone: null },
        specialRequests: 'Late arrival around 22:00',
        nightly: offer.nightly,
        guarantee: 'prepayment',
        externalCode: 'LDG-TEST01',
        comment: 'Paid via Lodgent',
        idempotencyKey: key,
      }),
    };
  }

  it('creates a reservation once per idempotency key', async () => {
    const first = await book('hold-1:create');
    const second = await book('hold-1:create');
    expect(second.reservation).toEqual(first.reservation);
    expect(fake.state.reservations.size).toBe(1);
    const stored = [...fake.state.reservations.values()][0]!;
    expect(stored).toMatchObject({
      externalCode: 'LDG-TEST01',
      guarantee: 'Prepayment',
      status: 'Confirmed',
    });
    expect(stored.timeSlices).toHaveLength(3);
    expect(
      fake.state.requests.find((r) => r.method === 'POST' && r.url === '/booking/v1/bookings')
        ?.idempotencyKey,
    ).toBe('hold-1:create');
  });

  it('reduces availability, cancels and records payments', async () => {
    const before = (
      await client().getOffers({ pmsPropertyId: 'LIS', arrival, departure, adults: 2, childrenAges: [] })
    ).find((o) => o.pmsRatePlanId === 'LIS-SUI-NRF')!.availableUnits;
    const { reservation, offer } = await book('hold-2:create');
    const after = (
      await client().getOffers({ pmsPropertyId: 'LIS', arrival, departure, adults: 2, childrenAges: [] })
    ).find((o) => o.pmsRatePlanId === 'LIS-SUI-NRF')!.availableUnits;
    expect(after).toBe(before - 1);

    await client().recordPayment({
      pmsReservationId: reservation.pmsReservationId,
      amount: offer.total,
      reference: 'pi_123',
      idempotencyKey: 'hold-2:payment',
    });
    await client().recordPayment({
      pmsReservationId: reservation.pmsReservationId,
      amount: offer.total,
      reference: 'pi_123',
      idempotencyKey: 'hold-2:payment',
    });
    const stored = fake.state.reservations.get(reservation.pmsReservationId)!;
    expect(stored.payments).toEqual([
      {
        method: 'CreditCard',
        receipt: 'pi_123',
        amount: { amount: offer.total.amount / 100, currency: 'EUR' },
      },
    ]);

    expect((await client().getReservation(reservation.pmsReservationId))?.status).toBe('confirmed');
    await client().cancelReservation(reservation.pmsReservationId);
    expect((await client().getReservation(reservation.pmsReservationId))?.status).toBe('cancelled');
    expect(await client().getReservation('NOPE-1')).toBeNull();
  });

  it('surfaces PMS rejections as upstream errors', async () => {
    await fetch(`${base}/_fake/fail-next`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'createBooking', status: 422 }),
    });
    await expect(book('hold-3:create')).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('delivers reservation webhooks to subscribed endpoints', async () => {
    const received: unknown[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        received.push(JSON.parse(body));
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    const subscriptionId = await client().subscribeWebhooks(url, ['LIS']);
    expect(subscriptionId).toMatch(/^sub_/);
    await book('hold-4:create');
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual([
      expect.objectContaining({
        topic: 'Reservation',
        type: 'created',
        accountId: 'DEMO',
        propertyId: 'LIS',
      }),
    ]);
    await client().unsubscribeWebhooks(subscriptionId);
    server.close();
  });
});
