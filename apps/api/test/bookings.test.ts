import type { AddressInfo } from 'node:net';
import { createFakeApaleo, type FakeApaleo } from '@lodgent/apaleo/fake';
import { createJobHandlers, PgJobRunner } from '@lodgent/application';
import { createFakeStripe, type FakeStripe } from '@lodgent/payments/fake';
import { addDays, localDateAt } from '@lodgent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectApaleo, createTestApp, newOrg, publishProperty, type TestApp, uniqueEmail } from './helpers';

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON responses.
type Json = any;

let apaleo: FakeApaleo;
let stripe: FakeStripe;
let app: TestApp;
let orgId: string;
let token: string;
let viewerToken: string;
let lisbon: string;
let partnerKey: string;
const stripeBase = () => `http://127.0.0.1:${(stripe.app.server.address() as AddressInfo).port}`;

const checkIn = addDays(localDateAt(new Date(), 'Europe/Lisbon'), 30);
const checkOut = addDays(checkIn, 2);

async function runJobs() {
  const runner = new PgJobRunner({
    db: app.container.db,
    clock: app.container.clock,
    logger: app.container.logger,
    handlers: createJobHandlers(app.container),
  });
  for (let i = 0; i < 10; i++) if ((await runner.runOnce(10)) === 0) break;
}

/** An agent books end to end: search, view, offers, hold, guest checkout, payment. */
async function agentBooks(options: {
  ratePlan: string;
  roomType: string;
  headers: Record<string, string>;
  guest: { firstName: string; lastName: string; email: string };
  pay?: boolean;
}) {
  const h = { headers: options.headers };
  await app.call('POST', '/v1/agent/search', {
    ...h,
    body: { destination: 'Lisbon', checkIn, checkOut, adults: 2 },
  });
  await app.call('GET', `/v1/agent/hotels/${lisbon}`, h);
  const offers = await app.call(
    'GET',
    `/v1/agent/hotels/${lisbon}/offers?checkIn=${checkIn}&checkOut=${checkOut}&adults=2`,
    h,
  );
  const offer = offers.body.offers.find(
    (o: Json) => o.ratePlan.name === options.ratePlan && o.roomType.name === options.roomType,
  );
  const hold = await app.call('POST', '/v1/agent/holds', { ...h, body: { offerId: offer.offerId } });
  expect(hold.status).toBe(201);
  const t = (hold.body.checkoutUrl as string).split('/checkout/')[1]!;
  const started = await app.call('POST', `/v1/checkout/${t}/guest`, {
    body: { ...options.guest, phone: '+351 912 000 000', acceptTerms: true },
  });
  expect(started.status).toBe(200);
  if (options.pay === false) return { offer, reference: started.body.booking?.reference ?? null };
  await stripe.confirm(started.body.payment.clientSecret, 'succeed');
  const done = await app.call('POST', `/v1/checkout/${t}/complete`);
  expect(done.body.status).toBe('confirmed');
  return { offer, reference: done.body.booking.reference as string };
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

  ({ token, orgId } = await newOrg(app, 'Casa Azul Hotels'));
  await connectApaleo(app, apaleoUrl, token, orgId);
  await app.container.services.pmsSync.syncOrganization(orgId);
  const { body } = await app.call('GET', `/v1/orgs/${orgId}/properties`, { token });
  lisbon = body.properties.find((p: Json) => p.pmsPropertyId === 'LIS').id;
  await publishProperty(app, token, orgId, lisbon, {
    values: { free_wifi: true, boutique: true, river_view: true },
    ratePlanCodes: ['FLEX', 'NRF'],
  });
  const start = await app.call('POST', `/v1/orgs/${orgId}/payments/onboarding`, { token });
  await stripe.completeOnboarding(new URL(start.body.url).pathname.split('/').pop()!);
  await runJobs();

  const viewerEmail = uniqueEmail('viewer');
  await app.call('POST', `/v1/orgs/${orgId}/invitations`, {
    token,
    body: { email: viewerEmail, role: 'viewer' },
  });
  await app.container.services.outbox.dispatchBatch();
  const invite = app.mailer.sent.at(-1)!.text.match(/\/invite\/([A-Za-z0-9_-]+)/)![1]!;
  viewerToken = (await app.login(viewerEmail)).token;
  await app.call('POST', '/v1/invitations/accept', { token: viewerToken, body: { token: invite } });

  partnerKey = (await app.container.services.agentClients.create({ name: 'Trip Planner AI' })).apiKey;
});

afterAll(async () => {
  await app.close();
  await stripe.app.close();
  await apaleo.app.close();
});

describe('bookings, funnel and fees', () => {
  let prepaidRef: string;
  let payAtHotelRef: string;

  it('lists agent bookings with fee, agent and PMS link', async () => {
    prepaidRef = (
      await agentBooks({
        ratePlan: 'Non-refundable saver',
        roomType: 'Classic Double',
        headers: { 'x-agent-name': 'claude-ai' },
        guest: { firstName: 'Ana', lastName: 'Silva', email: 'ana@example.com' },
      })
    ).reference;
    payAtHotelRef = (
      await agentBooks({
        ratePlan: 'Flexible rate',
        roomType: 'Deluxe River View',
        headers: { authorization: `Bearer ${partnerKey}` },
        guest: { firstName: '=HYPERLINK("http://x")', lastName: 'Costa', email: 'rui@example.com' },
      })
    ).reference;
    // A guest who started checkout but never paid.
    await agentBooks({
      ratePlan: 'Flexible rate',
      roomType: 'Classic Double',
      headers: { 'x-agent-name': 'claude-ai' },
      guest: { firstName: 'Eva', lastName: 'Lopes', email: 'eva@example.com' },
      pay: false,
    });

    const list = await app.call('GET', `/v1/orgs/${orgId}/bookings`, { token });
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(3);
    const prepaid = list.body.bookings.find((b: Json) => b.reference === prepaidRef);
    expect(prepaid).toMatchObject({
      status: 'confirmed',
      paymentMode: 'prepaid',
      propertyName: 'Casa Azul Lisboa',
      roomTypeName: 'Classic Double',
      nights: 2,
      guestName: 'Ana Silva',
      feeBps: 200,
      feeStatus: 'collected',
      agent: { name: 'claude-ai', partner: false, channel: 'rest' },
    });
    expect(prepaid.feeAmount).toBe(Math.round(prepaid.totalAmount * 0.02));
    expect(prepaid.pmsUrl).toMatch(new RegExp(`/app/LIS/reservations/${prepaid.pmsReservationId}$`));
    const payAtHotel = list.body.bookings.find((b: Json) => b.reference === payAtHotelRef);
    expect(payAtHotel).toMatchObject({
      paymentMode: 'pay_at_hotel',
      feeStatus: 'pending',
      agent: { name: 'Trip Planner AI', partner: true },
    });

    // Filters: status, search by surname, paging.
    const pending = await app.call('GET', `/v1/orgs/${orgId}/bookings?status=pending_payment`, { token });
    expect(pending.body.bookings.map((b: Json) => b.guestName)).toEqual(['Eva Lopes']);
    const bySurname = await app.call('GET', `/v1/orgs/${orgId}/bookings?q=cost`, { token });
    expect(bySurname.body.bookings.map((b: Json) => b.reference)).toEqual([payAtHotelRef]);
    const page = await app.call('GET', `/v1/orgs/${orgId}/bookings?limit=1&offset=1`, { token });
    expect(page.body).toMatchObject({ total: 3, limit: 1, offset: 1 });
    expect(page.body.bookings).toHaveLength(1);
    expect((await app.call('GET', `/v1/orgs/${orgId}/bookings?status=bogus`, { token })).status).toBe(400);
  });

  it('shows a booking’s detail; contact details only to roles that manage guest data', async () => {
    const list = await app.call('GET', `/v1/orgs/${orgId}/bookings?q=${prepaidRef}`, { token });
    const id = list.body.bookings[0].id;
    const detail = await app.call('GET', `/v1/orgs/${orgId}/bookings/${id}`, { token });
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      reference: prepaidRef,
      guestEmail: 'ana@example.com',
      guestPhone: '+351 912 000 000',
      fee: { collection: 'application_fee', status: 'collected' },
      payment: { status: 'succeeded', paymentIntentId: expect.stringMatching(/^pi_/), dashboardUrl: null },
    });
    expect(detail.body.price.nightly).toHaveLength(2);
    expect(detail.body.timeline.map((t: Json) => t.label)).toEqual([
      'Checkout started',
      'Payment authorized',
      expect.stringMatching(/^Reservation confirmed/),
    ]);
    const asViewer = await app.call('GET', `/v1/orgs/${orgId}/bookings/${id}`, { token: viewerToken });
    expect(asViewer.status).toBe(200);
    expect(asViewer.body).toMatchObject({ guestName: 'Ana Silva', guestEmail: null, guestPhone: null });

    const other = await newOrg(app, 'Someone Else');
    expect(
      (await app.call('GET', `/v1/orgs/${other.orgId}/bookings/${id}`, { token: other.token })).status,
    ).toBe(404);
  });

  it('builds the agent funnel by stage and agent', async () => {
    const res = await app.call('GET', `/v1/orgs/${orgId}/funnel?days=7&propertyId=${lisbon}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.timeZone).toBe('Europe/Lisbon');
    expect(res.body.totals).toMatchObject({ checkouts: 3, paid: 2, reservations: 2, holds: 3 });
    expect(res.body.totals.searches).toBeGreaterThanOrEqual(3);
    expect(res.body.totals.offers).toBe(3);
    expect(res.body.stages.map((s: Json) => s.key)).toEqual([
      'searches',
      'views',
      'offers',
      'holds',
      'checkouts',
      'paid',
      'reservations',
    ]);
    const claude = res.body.byAgent.find((a: Json) => a.name === 'claude-ai');
    expect(claude.counts).toMatchObject({ holds: 2, checkouts: 2, paid: 1, reservations: 1 });
    const partner = res.body.byAgent.find((a: Json) => a.name === 'Trip Planner AI');
    expect(partner).toMatchObject({ partner: true, counts: { holds: 1, reservations: 1 } });
    expect(res.body.daily).toHaveLength(7);
    expect(res.body.daily.at(-1).checkouts).toBe(3);
    expect((await app.call('GET', `/v1/orgs/${orgId}/funnel?days=12`, { token })).status).toBe(400);
  });

  it('exports bookings as CSV without contact details and with formulas neutralized', async () => {
    const res = await app.call('GET', `/v1/orgs/${orgId}/exports/bookings.csv?status=confirmed`, { token });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toContain('bookings.csv');
    const lines = (res.body as string).trim().split('\r\n');
    expect(lines[0]).toMatch(/^reference,property,status,booked_at/);
    expect(lines).toHaveLength(3);
    expect(res.body).not.toContain('ana@example.com');
    expect(res.body).toContain(`"'=HYPERLINK(""http://x"") Costa"`);
    expect(res.body).toMatch(new RegExp(`${prepaidRef},Casa Azul Lisboa,confirmed,`));
  });

  it('invoices pay-at-hotel fees monthly after the stay and marks them collected when paid', async () => {
    const billing = app.container.services.billing;
    // Before the stay has ended there is nothing to invoice.
    expect(await billing.invoiceOrg(orgId, '2026-01', checkIn)).toEqual([]);

    const departedBefore = addDays(checkOut, 1);
    const period = departedBefore.slice(0, 7);
    const [invoice] = await billing.invoiceOrg(orgId, period, departedBefore);
    expect(invoice).toMatchObject({ status: 'open', period, currency: 'EUR', feeCount: 1 });
    expect(invoice!.number).toMatch(/^LODG-/);
    // Running again (a retry, or the next daily run) issues nothing new.
    expect(await billing.invoiceOrg(orgId, period, departedBefore)).toEqual([]);
    // A run that stopped after creating the row but before Stripe finishes it on the next sync.
    expect((await billing.syncInvoice(orgId, invoice!.id))?.status).toBe('open');
    expect(stripe.state.requests.filter((r) => r.url === '/v1/invoices' && r.method === 'POST')).toHaveLength(
      1,
    );

    const fake = stripe.state.objects.get(invoice!.providerInvoiceId!)!;
    expect(fake).toMatchObject({ customer: expect.stringMatching(/^cus_/), _account: null });
    expect((fake.lines as Json).data[0].description).toMatch(/^Casa Azul Lisboa: 1 agent booking/);

    let fees = await app.call('GET', `/v1/orgs/${orgId}/fees`, { token });
    expect(fees.body.invoices[0]).toMatchObject({ status: 'open', amount: invoice!.amount });
    expect(fees.body.properties.find((p: Json) => p.id === lisbon).feeBps).toBe(200);

    await stripe.payInvoice(invoice!.providerInvoiceId!); // webhook → sync job
    await runJobs();
    fees = await app.call('GET', `/v1/orgs/${orgId}/fees`, { token });
    expect(fees.body.invoices[0]).toMatchObject({ status: 'paid', paidAt: expect.any(String) });
    const month = fees.body.months[0];
    expect(month).toMatchObject({ currency: 'EUR', bookings: 2, pending: 0, invoiced: 0 });
    expect(month.collected).toBeGreaterThan(invoice!.amount);

    // Fee CSV for the month, and billing is for managers only.
    const csv = await app.call(
      'GET',
      `/v1/orgs/${orgId}/exports/fees.csv?period=${fees.body.months[0].period}`,
      {
        token,
      },
    );
    expect(csv.status).toBe(200);
    expect(csv.body).toContain(invoice!.number);
    expect(csv.body).toContain('monthly_invoice,collected');
    expect((await app.call('GET', `/v1/orgs/${orgId}/fees`, { token: viewerToken })).status).toBe(403);
  });

  it('resumes an invoice whose issuing stopped half-way', async () => {
    await agentBooks({
      ratePlan: 'Flexible rate',
      roomType: 'Deluxe River View',
      headers: { 'x-agent-name': 'claude-ai' },
      guest: { firstName: 'Rui', lastName: 'Matos', email: 'rui.m@example.com' },
    });
    const billing = app.container.services.billing;
    await fetch(`${stripeBase()}/_fake/fail-next`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'invoices.finalize', status: 400 }),
    });
    await expect(billing.invoiceOrg(orgId, '2099-12', '2100-01-01')).rejects.toThrow(/finalization failed/);
    const fees = await app.call('GET', `/v1/orgs/${orgId}/fees`, { token });
    const draft = fees.body.invoices.find((i: Json) => i.period === '2099-12');
    expect(draft).toMatchObject({ status: 'draft', feeCount: 1, number: null });

    // The daily run re-checks drafts and finishes them with the same idempotency keys.
    await billing.runDaily();
    await runJobs();
    const after = await app.call('GET', `/v1/orgs/${orgId}/fees`, { token });
    const issued = after.body.invoices.find((i: Json) => i.id === draft.id);
    expect(issued).toMatchObject({ status: 'open', number: expect.stringMatching(/^LODG-/) });
    // The retry replayed the line instead of adding it twice.
    const invoices = [...stripe.state.objects.values()].filter((o) => o.object === 'invoice');
    const resumed = invoices.find((o) => o.number === issued.number)!;
    expect((resumed.lines as Json).data).toHaveLength(1);
    expect(resumed.amount_due).toBe(issued.amount);
  });

  it('lets the operator change a property’s fee rate for new holds only', async () => {
    const billing = app.container.services.billing;
    await expect(billing.setFeeRate(lisbon, 5_000)).rejects.toThrow(/between 0 and 2000/);
    expect(await billing.setFeeRate(lisbon, 150)).toEqual({ from: 200, to: 150 });
    const fees = await app.call('GET', `/v1/orgs/${orgId}/fees`, { token });
    expect(fees.body.properties.find((p: Json) => p.id === lisbon).feeBps).toBe(150);
    // Bookings already made keep their quoted fee.
    const list = await app.call('GET', `/v1/orgs/${orgId}/bookings?status=confirmed`, { token });
    expect(list.body.bookings.every((b: Json) => b.feeBps === 200)).toBe(true);
    const offers = await app.call(
      'GET',
      `/v1/agent/hotels/${lisbon}/offers?checkIn=${checkIn}&checkOut=${checkOut}&adults=2`,
    );
    const hold = await app.call('POST', '/v1/agent/holds', {
      body: { offerId: offers.body.offers[0].offerId },
    });
    expect(hold.status).toBe(201);
    const row = await app.container.db.tenant(orgId, (r) => r.holds.get(hold.body.holdId));
    expect(row?.feeBps).toBe(150);
  });
});
