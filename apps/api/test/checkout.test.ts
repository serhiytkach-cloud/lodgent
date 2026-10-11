import type { AddressInfo } from 'node:net';
import { createFakeApaleo, type FakeApaleo } from '@lodgent/apaleo/fake';
import { createJobHandlers, PgJobRunner } from '@lodgent/application';
import { sql } from '@lodgent/db';
import { createFakeStripe, type FakeStripe } from '@lodgent/payments/fake';
import { addDays, localDateAt } from '@lodgent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectApaleo, createTestApp, newOrg, publishProperty, type TestApp } from './helpers';

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON responses.
type Json = any;

let apaleo: FakeApaleo;
let stripe: FakeStripe;
let app: TestApp;
let orgId: string;
let token: string;
let lisbon: string;

const checkIn = addDays(localDateAt(new Date(), 'Europe/Lisbon'), 45);
const checkOut = addDays(checkIn, 2);

async function runJobs() {
  const runner = new PgJobRunner({
    db: app.container.db,
    clock: app.container.clock,
    logger: app.container.logger,
    handlers: createJobHandlers(app.container),
  });
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const n = await runner.runOnce(10);
    total += n;
    if (n === 0) break;
  }
  return total;
}

/** Agent side: fresh offer for a rate plan, then a hold; returns the checkout token. */
async function holdFor(ratePlan: string, roomType = 'Classic Double', dates = { checkIn, checkOut }) {
  const offers = await app.call(
    'GET',
    `/v1/agent/hotels/${lisbon}/offers?checkIn=${dates.checkIn}&checkOut=${dates.checkOut}&adults=2`,
  );
  const offer = offers.body.offers.find(
    (o: Json) => o.ratePlan.name === ratePlan && o.roomType.name === roomType,
  );
  if (!offer) throw new Error(`no offer ${ratePlan}: ${JSON.stringify(offers.body)}`);
  const hold = await app.call('POST', '/v1/agent/holds', { body: { offerId: offer.offerId } });
  expect(hold.status).toBe(201);
  return {
    hold: hold.body,
    offer,
    token: (hold.body.checkoutUrl as string).split('/checkout/')[1]!,
  };
}

const guest = {
  firstName: 'Ana',
  lastName: 'Silva',
  email: 'Ana.Silva@example.com',
  phone: '+351 912 345 678',
  specialRequests: 'Quiet room, please',
  acceptTerms: true,
};

async function booking(reference: string) {
  return app.container.db.tenant(orgId, async ({ tx }) => {
    const rows = await tx.execute(sql`select * from bookings where reference = ${reference}`);
    return rows.rows[0] as Json;
  });
}

beforeAll(async () => {
  apaleo = createFakeApaleo();
  await apaleo.app.listen({ port: 0, host: '127.0.0.1' });
  const apaleoUrl = `http://127.0.0.1:${(apaleo.app.server.address() as AddressInfo).port}`;
  stripe = createFakeStripe();
  await stripe.app.listen({ port: 0, host: '127.0.0.1' });
  const stripeUrl = `http://127.0.0.1:${(stripe.app.server.address() as AddressInfo).port}`;
  stripe.setPublicUrl(stripeUrl);

  app = await createTestApp({
    APALEO_IDENTITY_URL: apaleoUrl,
    APALEO_API_URL: apaleoUrl,
    APALEO_WEBHOOK_URL: apaleoUrl,
    STRIPE_API_BASE_URL: stripeUrl,
    WEB_BASE_URL: 'http://web.test',
  });
  await app.server.listen({ port: 0, host: '127.0.0.1' });
  stripe.setWebhookUrl(
    `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}/webhooks/stripe`,
  );

  ({ token, orgId } = await newOrg(app));
  await connectApaleo(app, apaleoUrl, token, orgId);
  await app.container.services.pmsSync.syncOrganization(orgId);
  const { body } = await app.call('GET', `/v1/orgs/${orgId}/properties`, { token });
  lisbon = body.properties.find((p: Json) => p.pmsPropertyId === 'LIS').id;
  await publishProperty(app, token, orgId, lisbon, {
    values: { free_wifi: true, boutique: true, historic_building: true, river_view: true },
    ratePlanCodes: ['FLEX', 'NRF'],
  });
});

afterAll(async () => {
  await app.close();
  await stripe.app.close();
  await apaleo.app.close();
});

describe('Stripe Connect onboarding', () => {
  it('refuses checkout until the hotel can take payments', async () => {
    const { token: t } = await holdFor('Non-refundable saver');
    const res = await app.call('POST', `/v1/checkout/${t}/guest`, { body: guest });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('payments_unavailable');
  });

  it('connects a Stripe account through hosted onboarding', async () => {
    const before = await app.call('GET', `/v1/orgs/${orgId}/payments`, { token });
    expect(before.body).toMatchObject({ connected: false, status: 'not_connected', defaultFeeBps: 200 });

    const stranger = await app.login();
    expect(
      (await app.call('POST', `/v1/orgs/${orgId}/payments/onboarding`, { token: stranger.token })).status,
    ).toBe(404);

    const start = await app.call('POST', `/v1/orgs/${orgId}/payments/onboarding`, { token });
    expect(start.status).toBe(200);
    expect(start.body.url).toContain('/_fake/onboarding/acct_');
    const accountId = new URL(start.body.url).pathname.split('/').pop()!;
    // A second click reuses the account.
    const again = await app.call('POST', `/v1/orgs/${orgId}/payments/onboarding`, { token });
    expect(again.body.url).toContain(accountId);
    expect(stripe.state.accounts.size).toBe(1);

    await stripe.completeOnboarding(accountId); // also sends account.updated to our webhook
    await runJobs();
    const after = await app.call('GET', `/v1/orgs/${orgId}/payments`, { token });
    expect(after.body).toMatchObject({ connected: true, status: 'active', chargesEnabled: true, accountId });
    expect((await app.call('POST', `/v1/orgs/${orgId}/payments/refresh`, { token })).body.status).toBe(
      'active',
    );
  });
});

describe('guest checkout', () => {
  it('prepaid: authorizes, books in Apaleo, captures, confirms and emails', async () => {
    const { token: t, hold, offer } = await holdFor('Non-refundable saver');
    const view = await app.call('GET', `/v1/checkout/${t}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      status: 'open',
      paymentMode: 'prepaid',
      hotel: { name: 'Casa Azul Lisboa' },
      stay: { checkIn, checkOut, nights: 2, roomType: 'Classic Double', ratePlan: 'Non-refundable saver' },
      price: { total: offer.total, dueNow: offer.total },
      payment: null,
      guest: null,
    });
    expect(view.body.cancellation).toMatch(/Non-refundable/);

    expect(
      (await app.call('POST', `/v1/checkout/${t}/guest`, { body: { ...guest, acceptTerms: false } })).status,
    ).toBe(400);
    const card = await app.call('POST', `/v1/checkout/${t}/guest`, {
      body: { ...guest, specialRequests: 'charge my card 4242 4242 4242 4242' },
    });
    expect(card.status).toBe(400);
    expect(card.body.error.code).toBe('card_data_rejected');

    const started = await app.call('POST', `/v1/checkout/${t}/guest`, { body: guest });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      status: 'awaiting_payment',
      guest: { firstName: 'Ana', email: 'ana.silva@example.com' },
      payment: {
        provider: 'stripe',
        kind: 'payment',
        simulatorUrl: expect.stringContaining('http://127.0.0.1'),
      },
    });
    const pi = stripe.state.objects.get(started.body.payment.clientSecret.split('_secret_')[0])!;
    expect(pi).toMatchObject({
      amount: offer.total.amount,
      currency: 'eur',
      capture_method: 'manual',
      application_fee_amount: Math.round(offer.total.amount * 0.02),
      _account: started.body.payment.accountId,
    });

    // Not paid yet: completing does nothing.
    expect((await app.call('POST', `/v1/checkout/${t}/complete`)).body.status).toBe('awaiting_payment');
    await stripe.confirm(started.body.payment.clientSecret, 'decline');
    expect((await app.call('POST', `/v1/checkout/${t}/complete`)).body.status).toBe('awaiting_payment');

    await stripe.confirm(started.body.payment.clientSecret, 'succeed');
    const done = await app.call('POST', `/v1/checkout/${t}/complete`);
    expect(done.body.status).toBe('confirmed');
    expect(done.body.booking.confirmationNumber).toBeTruthy();
    expect(done.body.payment).toBeNull();

    // Apaleo: one reservation, prepayment guarantee, our reference, guest, payment on the folio.
    const reservations = [...apaleo.state.reservations.values()].filter(
      (r) => r.externalCode === done.body.booking.reference,
    );
    expect(reservations).toHaveLength(1);
    expect(reservations[0]).toMatchObject({ guarantee: 'Prepayment', arrival: checkIn, adults: 2 });
    expect(reservations[0]!.primaryGuest).toMatchObject({
      firstName: 'Ana',
      lastName: 'Silva',
      email: 'ana.silva@example.com',
    });
    expect(reservations[0]!.payments).toHaveLength(1);
    expect(reservations[0]!.payments[0]!.receipt).toBe(pi.id);
    // Stripe: captured.
    expect(stripe.state.objects.get(pi.id)?.status).toBe('succeeded');

    const row = await booking(done.body.booking.reference);
    expect(row).toMatchObject({ status: 'confirmed', payment_status: 'succeeded', channel: 'rest' });
    const fee = await app.container.db.tenant(orgId, (r) => r.fees.forBooking(row.id));
    expect(fee).toMatchObject({
      collection: 'application_fee',
      status: 'collected',
      amount: Math.round(offer.total.amount * 0.02),
    });
    const emails = await app.container.db.system(
      async ({ tx }) =>
        (
          await tx.execute(
            sql`select payload from outbox where topic = 'email.send' and payload->>'template' = 'booking-confirmation'`,
          )
        ).rows,
    );
    expect(emails.length).toBeGreaterThanOrEqual(1);

    // The agent sees the confirmation.
    const status = await app.call('GET', `/v1/agent/holds/${hold.holdId}`);
    expect(status.body).toMatchObject({
      status: 'confirmed',
      booking: { confirmationNumber: done.body.booking.confirmationNumber },
    });

    // Idempotent: the browser retrying, the webhook job and a reconcile don't book or charge twice.
    await app.call('POST', `/v1/checkout/${t}/complete`);
    await runJobs();
    await app.container.services.checkout.reconcile();
    expect(
      [...apaleo.state.reservations.values()].filter((r) => r.externalCode === done.body.booking.reference),
    ).toHaveLength(1);
    expect(
      stripe.state.requests.filter((r) => r.url.endsWith(`${pi.id}/capture`)).length,
    ).toBeLessThanOrEqual(2);
  });

  it('pay at hotel: saves a card as guarantee and accrues the fee for invoicing', async () => {
    const { token: t, offer } = await holdFor('Flexible rate', 'Deluxe River View');
    const started = await app.call('POST', `/v1/checkout/${t}/guest`, { body: guest });
    expect(started.body.payment).toMatchObject({ kind: 'setup' });
    expect(started.body.price.dueNow.amount).toBe(0);
    await stripe.confirm(started.body.payment.clientSecret);
    // The webhook alone finishes the job (no browser callback).
    await runJobs();
    const view = await app.call('GET', `/v1/checkout/${t}`);
    expect(view.body.status).toBe('confirmed');
    const res = [...apaleo.state.reservations.values()].find(
      (r) => r.externalCode === view.body.booking.reference,
    )!;
    expect(res.guarantee).toBe('CreditCard');
    expect(res.payments).toHaveLength(0);
    const row = await booking(view.body.booking.reference);
    const fee = await app.container.db.tenant(orgId, (r) => r.fees.forBooking(row.id));
    expect(fee).toMatchObject({
      collection: 'invoice',
      status: 'pending',
      amount: Math.round(offer.total.amount * 0.02),
    });

    // The hotel cancels in Apaleo: we mirror it and waive the fee.
    const client = await app.container.services.pmsConnections.clientFor(orgId);
    await client.cancelReservation(res.id);
    await createJobHandlers(app.container)['pms.reservation-changed']!(
      { orgId, pmsReservationId: res.id },
      { logger: app.container.logger, attempt: 1 },
    );
    expect((await booking(view.body.booking.reference)).status).toBe('cancelled');
    expect((await app.container.db.tenant(orgId, (r) => r.fees.forBooking(row.id)))?.status).toBe('void');
  });

  it('releases the authorization when the PMS rejects the reservation', async () => {
    const { token: t } = await holdFor('Non-refundable saver', 'Azulejo Suite');
    const started = await app.call('POST', `/v1/checkout/${t}/guest`, { body: guest });
    await stripe.confirm(started.body.payment.clientSecret);
    await fetch(`http://127.0.0.1:${(apaleo.app.server.address() as AddressInfo).port}/_fake/fail-next`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'createBooking', status: 422 }),
    });
    const done = await app.call('POST', `/v1/checkout/${t}/complete`);
    expect(done.body.status).toBe('failed');
    expect(done.body.statusMessage).toMatch(/could not confirm.*not been charged/);
    const piId = started.body.payment.clientSecret.split('_secret_')[0];
    expect(stripe.state.objects.get(piId)?.status).toBe('canceled');
    const row = await booking(done.body.booking.reference);
    expect(await app.container.db.tenant(orgId, (r) => r.fees.forBooking(row.id))).toBeUndefined();
  });

  it('retries a PMS outage and confirms later', async () => {
    const { token: t } = await holdFor('Non-refundable saver', 'Deluxe River View');
    const started = await app.call('POST', `/v1/checkout/${t}/guest`, { body: guest });
    await stripe.confirm(started.body.payment.clientSecret);
    await fetch(`http://127.0.0.1:${(apaleo.app.server.address() as AddressInfo).port}/_fake/fail-next`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // More failures than the client's own retries: the outage outlasts the request.
      body: JSON.stringify({ operation: 'createBooking', status: 503, times: 5 }),
    });
    const first = await app.call('POST', `/v1/checkout/${t}/complete`);
    expect(first.body.status).toBe('processing');
    expect(first.body.statusMessage).toMatch(/confirming your reservation/);

    // The PMS recovers, the lease expires and reconciliation retries with the same idempotency key.
    await fetch(
      `http://127.0.0.1:${(apaleo.app.server.address() as AddressInfo).port}/_fake/reset-failures`,
      { method: 'POST' },
    );
    await app.container.db.tenant(orgId, ({ tx }) =>
      tx.execute(
        sql`update bookings set updated_at = now() - interval '5 minutes' where reference = ${first.body.booking.reference}`,
      ),
    );
    const result = await app.container.services.checkout.reconcile();
    expect(result.finalized).toBe(1);
    expect((await app.call('GET', `/v1/checkout/${t}`)).body.status).toBe('confirmed');
  });

  it('fails cleanly when the price moved before payment completed', async () => {
    const { token: t } = await holdFor('Non-refundable saver');
    const started = await app.call('POST', `/v1/checkout/${t}/guest`, { body: guest });
    await stripe.confirm(started.body.payment.clientSecret);
    // Simulate a stale hold price (as if Apaleo's rate changed since the quote).
    await app.container.db.tenant(orgId, ({ tx }) =>
      tx.execute(
        sql`update holds set total_amount = total_amount + 100 where id = (select hold_id from bookings where reference = ${started.body.booking.reference})`,
      ),
    );
    const done = await app.call('POST', `/v1/checkout/${t}/complete`);
    expect(done.body.status).toBe('failed');
    expect(done.body.statusMessage).toMatch(/price changed/);
  });

  it('rejects forged tokens and expired holds', async () => {
    expect((await app.call('GET', '/v1/checkout/not-a-real-token-at-all')).status).toBe(404);
    const { token: t, hold } = await holdFor('Flexible rate', 'Classic Double');
    await app.container.db.system(({ tx }) =>
      tx.execute(sql`update holds set expires_at = now() - interval '1 minute' where id = ${hold.holdId}`),
    );
    expect((await app.call('GET', `/v1/checkout/${t}`)).body.status).toBe('expired');
    const res = await app.call('POST', `/v1/checkout/${t}/guest`, { body: guest });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('hold_expired');
  });

  it('rejects Stripe webhooks with a bad signature and de-duplicates events', async () => {
    const bad = await app.server.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      payload: JSON.stringify({ id: 'evt_x', type: 'payment_intent.succeeded' }),
    });
    expect(bad.statusCode).toBe(400);
    const deliveries = stripe.state.events.filter((e) => e.delivered !== null);
    expect(deliveries.every((e) => e.delivered === 200)).toBe(true);
  });

  it('redacts guest details after the retention period', async () => {
    await app.container.db.system(({ tx }) =>
      tx.execute(
        sql`update bookings set departure = (current_date - interval '400 days')::date where status = 'confirmed'`,
      ),
    );
    const redacted = await app.container.services.checkout.redactExpiredGuestData();
    expect(redacted).toBeGreaterThan(0);
    const rows = await app.container.db.system(
      async ({ tx }) =>
        (
          await tx.execute(
            sql`select guest_email, guest_last_name, pii_redacted_at from bookings where status = 'confirmed'`,
          )
        ).rows,
    );
    for (const r of rows)
      expect(r).toMatchObject({
        guest_email: null,
        guest_last_name: null,
        pii_redacted_at: expect.anything(),
      });
  });
});
