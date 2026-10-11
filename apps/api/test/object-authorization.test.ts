import type { AddressInfo } from 'node:net';
import { createFakeApaleo, type FakeApaleo } from '@lodgent/apaleo/fake';
import { createJobHandlers, PgJobRunner } from '@lodgent/application';
import { createFakeStripe, type FakeStripe } from '@lodgent/payments/fake';
import { addDays, localDateAt } from '@lodgent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnyRouteDef } from '../src/http/router';
import { connectApaleo, createTestApp, newOrg, publishProperty, type TestApp, uniqueEmail } from './helpers';

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON responses.
type Json = any;

/**
 * Object-level authorization (IDOR): a member of organization A, holding every permission there,
 * addresses organization B's resources through A's routes. Every such request must be a 404 and
 * leave B's data untouched, for every org route that takes a resource id, including ids that
 * travel in the body or query rather than the path. New routes with new id parameters fail the
 * sweep until a victim id is registered for them below.
 */

let apaleo: FakeApaleo;
let stripe: FakeStripe;
let app: TestApp;

/** The victim organization and one real resource of every kind. */
const victim = {
  token: '',
  orgId: '',
  propertyId: '',
  roomTypeId: '',
  ratePlanId: '',
  assignmentId: '',
  suggestionId: '',
  queryId: '',
  bookingId: '',
  memberUserId: '',
  invitationId: '',
};
/** The attacker: owner of organization A (every permission) with a property of their own. */
const attacker = { token: '', orgId: '', propertyId: '' };

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

/** Snapshot of the victim's data that every probe must leave unchanged. */
async function victimState() {
  const { token, orgId, propertyId } = victim;
  const get = async (path: string) => (await app.call('GET', `/v1/orgs/${orgId}${path}`, { token })).body;
  return {
    org: await get(''),
    members: await get('/members'),
    invitations: await get('/invitations'),
    property: await get(`/properties/${propertyId}`),
    rooms: await get(`/properties/${propertyId}/rooms`),
    profile: await get(`/properties/${propertyId}/profile`),
    visibility: (await get(`/properties/${propertyId}/visibility`)).queries,
    booking: await get(`/bookings/${victim.bookingId}`),
    publish: (await get(`/properties/${propertyId}/publish`)).status,
  };
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

  // Victim: a live hotel with a booking, a team, tracked questions and pending suggestions.
  Object.assign(victim, await newOrg(app, 'Victim Hotels'));
  const { token, orgId } = victim;
  await connectApaleo(app, apaleoUrl, token, orgId);
  await app.container.services.pmsSync.syncOrganization(orgId);
  const properties = await app.call('GET', `/v1/orgs/${orgId}/properties`, { token });
  victim.propertyId = properties.body.properties.find((p: Json) => p.pmsPropertyId === 'LIS').id;
  await publishProperty(app, token, orgId, victim.propertyId, {
    values: { free_wifi: true, boutique: true, river_view: true },
  });
  const onboarding = await app.call('POST', `/v1/orgs/${orgId}/payments/onboarding`, { token });
  await stripe.completeOnboarding(new URL(onboarding.body.url).pathname.split('/').pop()!);
  await app.call('POST', `/v1/orgs/${orgId}/payments/refresh`, { token });
  await runJobs();

  const rooms = await app.call('GET', `/v1/orgs/${orgId}/properties/${victim.propertyId}/rooms`, { token });
  victim.roomTypeId = rooms.body.roomTypes[0].id;
  victim.ratePlanId = rooms.body.roomTypes[0].ratePlans[0].id;

  await app.container.db.tenant(orgId, (r) =>
    r.descriptions.upsert(victim.propertyId, null, 'A suggested description.', 'website', null),
  );
  await app.container.services.catalog.mapPmsAttributes(orgId, victim.propertyId);
  const profile = await app.call('GET', `/v1/orgs/${orgId}/properties/${victim.propertyId}/profile`, {
    token,
  });
  victim.suggestionId = profile.body.descriptions[0].id;
  victim.assignmentId = [
    ...profile.body.categories.flatMap((c: Json) => c.attributes),
    ...profile.body.rooms.flatMap((r: Json) => r.attributes),
  ].find((a: Json) => a.effective)?.effective.assignmentId;

  const query = await app.call(
    'POST',
    `/v1/orgs/${orgId}/properties/${victim.propertyId}/visibility/queries`,
    {
      token,
      body: { text: 'Which boutique hotels in Lisbon have a river view?' },
    },
  );
  victim.queryId = query.body.id;

  const invitation = await app.call('POST', `/v1/orgs/${orgId}/invitations`, {
    token,
    body: { email: uniqueEmail('pending'), role: 'admin' },
  });
  victim.invitationId = invitation.body.id;
  const memberEmail = uniqueEmail('member');
  await app.call('POST', `/v1/orgs/${orgId}/invitations`, {
    token,
    body: { email: memberEmail, role: 'viewer' },
  });
  await app.container.services.outbox.dispatchBatch();
  const inviteToken = app.mailer.sent.at(-1)!.text.match(/\/invite\/([A-Za-z0-9_-]+)/)![1]!;
  const memberToken = (await app.login(memberEmail)).token;
  await app.call('POST', '/v1/invitations/accept', { token: memberToken, body: { token: inviteToken } });
  victim.memberUserId = (await app.call('GET', '/v1/me', { token: memberToken })).body.user.id;

  // A guest books through an agent.
  const offers = await app.call(
    'GET',
    `/v1/agent/hotels/${victim.propertyId}/offers?checkIn=${checkIn}&checkOut=${checkOut}&adults=2`,
  );
  const hold = await app.call('POST', '/v1/agent/holds', {
    body: { offerId: offers.body.offers[0].offerId },
  });
  expect(hold.status, JSON.stringify(hold.body)).toBe(201);
  const checkoutToken = (hold.body.checkoutUrl as string).split('/checkout/')[1]!;
  const started = await app.call('POST', `/v1/checkout/${checkoutToken}/guest`, {
    body: { firstName: 'Ana', lastName: 'Silva', email: 'ana@example.com', acceptTerms: true },
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const bookings = await app.call('GET', `/v1/orgs/${orgId}/bookings`, { token });
  victim.bookingId = bookings.body.bookings[0].id;

  // Attacker: owner of another organization with a property of their own.
  Object.assign(attacker, await newOrg(app, 'Attacker Hotels'));
  const own = await app.call('POST', `/v1/orgs/${attacker.orgId}/properties`, {
    token: attacker.token,
    body: { name: 'Attacker Inn', city: 'Lisbon' },
  });
  attacker.propertyId = own.body.id;

  for (const [key, value] of Object.entries(victim)) expect(value, key).toBeTruthy();
});

afterAll(async () => {
  await app.close();
  await stripe.app.close();
  await apaleo.app.close();
});

/** The victim's id for each path parameter an org route can take. */
const victimIdFor: Record<string, () => string> = {
  propertyId: () => victim.propertyId,
  ratePlanId: () => victim.ratePlanId,
  suggestionId: () => victim.suggestionId,
  queryId: () => victim.queryId,
  bookingId: () => victim.bookingId,
  userId: () => victim.memberUserId,
  invitationId: () => victim.invitationId,
};

/** A valid body/query per operation, carrying victim ids wherever the input references resources. */
function inputFor(route: AnyRouteDef): { body?: unknown; query?: string } {
  switch (route.operationId) {
    case 'updateProperty':
      return { body: { name: 'Hijacked' } };
    case 'updateRatePlan':
      return { body: { exposedToAgents: false } };
    case 'reviewProfile':
      return { body: { approve: [], reject: [victim.assignmentId] } };
    case 'setProfileAttribute':
      return { body: { attributeCode: 'balcony', roomTypeId: victim.roomTypeId, value: true } };
    case 'reviewDescription':
      return { body: { accept: true } };
    case 'addVisibilityQuery':
      return { body: { text: 'Is this an injected traveller question?' } };
    case 'changeMemberRole':
      return { body: { role: 'owner' } };
    case 'previewOffers':
      return { query: `?checkIn=${checkIn}&checkOut=${checkOut}&adults=2` };
    default:
      if (route.body) throw new Error(`Add a valid sample body for ${route.operationId}`);
      return {};
  }
}

function resourceParams(route: AnyRouteDef): string[] {
  return [...route.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!).filter((p) => p !== 'orgId');
}

describe('another organization’s resources are invisible', () => {
  it('returns 404 for every org route addressed with the victim’s ids', async () => {
    const before = await victimState();
    const routes = app.router.routes.filter((r) => r.auth === 'org' && resourceParams(r).length > 0);
    expect(routes.length).toBeGreaterThan(10);
    for (const route of routes) {
      const params = resourceParams(route);
      for (const param of params) expect(victimIdFor[param], `no victim id for :${param}`).toBeDefined();
      const { body, query = '' } = inputFor(route);
      // 1. Everything from the victim, under the attacker's organization.
      // 2. The attacker's own property, with the victim's sub-resource ids.
      const variants = [(p: string) => victimIdFor[p]!()];
      if (params.includes('propertyId') && params.length > 1)
        variants.push((p: string) => (p === 'propertyId' ? attacker.propertyId : victimIdFor[p]!()));
      for (const idFor of variants) {
        const path = route.path
          .replace(':orgId', attacker.orgId)
          .replace(/:([A-Za-z]+)/g, (_, p: string) => idFor(p));
        const res = await app.call(route.method, `${path}${query}`, { token: attacker.token, body });
        expect(res.status, `${route.method} ${path} → ${JSON.stringify(res.body)}`).toBe(404);
      }
    }
    expect(await victimState()).toEqual(before);
  });

  it('ignores the victim’s ids in body fields and query filters', async () => {
    const base = `/v1/orgs/${attacker.orgId}`;
    const own = `${base}/properties/${attacker.propertyId}`;
    const review = await app.call('POST', `${own}/profile/review`, {
      token: attacker.token,
      body: { approve: [victim.assignmentId], reject: [] },
    });
    expect(review.status).toBe(404);
    const attribute = await app.call('PUT', `${own}/profile/attributes`, {
      token: attacker.token,
      body: { attributeCode: 'balcony', roomTypeId: victim.roomTypeId, value: true },
    });
    expect(attribute.status).toBe(404);
    const funnel = await app.call('GET', `${base}/funnel?propertyId=${victim.propertyId}`, {
      token: attacker.token,
    });
    expect(funnel.status).toBe(404);
    const list = await app.call('GET', `${base}/bookings?propertyId=${victim.propertyId}`, {
      token: attacker.token,
    });
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(0);
    const csv = await app.call('GET', `${base}/exports/bookings.csv?propertyId=${victim.propertyId}`, {
      token: attacker.token,
    });
    expect(csv.status).toBe(200);
    expect(String(csv.body)).not.toMatch(/Silva|Casa Azul/);
  });

  it('keeps the victim’s routes closed to the attacker', async () => {
    for (const route of app.router.routes.filter((r) => r.auth === 'org')) {
      const path = route.path
        .replace(':orgId', victim.orgId)
        .replace(/:([A-Za-z]+)/g, (_, p: string) => victimIdFor[p]!());
      // Membership is checked before the input is parsed, so any body gets the same answer.
      const res = await app.call(route.method, path, {
        token: attacker.token,
        body: route.body ? {} : undefined,
      });
      expect(res.status, `${route.method} ${path}`).toBe(404);
    }
  });
});
