import type { AddressInfo } from 'node:net';
import { createFakeApaleo, type FakeApaleo } from '@lodgent/apaleo/fake';
import { addDays, localDateAt } from '@lodgent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectApaleo, newOrg as createOrg, createTestApp, type TestApp } from './helpers';

let fake: FakeApaleo;
let app: TestApp;
let fakeUrl: string;

const checkIn = addDays(localDateAt(new Date(), 'Europe/Lisbon'), 21);
const checkOut = addDays(checkIn, 2);

beforeAll(async () => {
  // Short-lived access tokens force a refresh on almost every call (and Apaleo rotates refresh tokens).
  fake = createFakeApaleo({ accessTokenTtlSeconds: 75 });
  await fake.app.listen({ port: 0, host: '127.0.0.1' });
  fakeUrl = `http://127.0.0.1:${(fake.app.server.address() as AddressInfo).port}`;
  app = await createTestApp({
    APALEO_IDENTITY_URL: fakeUrl,
    APALEO_API_URL: fakeUrl,
    APALEO_WEBHOOK_URL: fakeUrl,
    WEB_BASE_URL: 'http://web.test',
  });
});

afterAll(async () => {
  await app.close();
  await fake.app.close();
});

const connect = (token: string, orgId: string, account = 'DEMO') =>
  connectApaleo(app, fakeUrl, token, orgId, account);
const newOrg = (name: string) => createOrg(app, name);

describe('Apaleo connection and sync', () => {
  let token: string;
  let orgId: string;

  beforeAll(async () => {
    ({ token, orgId } = await newOrg('Demo Boutique Hotels'));
  });

  it('connects through OAuth and stores encrypted tokens', async () => {
    const location = await connect(token, orgId);
    expect(location).toBe(`http://web.test/app/${orgId}/settings/connections?apaleo=connected`);
    const status = await app.call('GET', `/v1/orgs/${orgId}/integrations/apaleo`, { token });
    expect(status.body).toMatchObject({ connected: true, accountCode: 'DEMO', status: 'active' });

    const stored = await app.container.db.tenant(orgId, (r) => r.pmsConnection.get());
    expect(stored?.encryptedTokens).not.toMatch(/fat_|frt_/);
  });

  it('imports properties, room types, rate plans and policies idempotently', async () => {
    const first = await app.container.services.pmsSync.syncOrganization(orgId);
    expect(first).toMatchObject({ properties: 3, propertiesCreated: 3, roomTypes: 9 });
    const second = await app.container.services.pmsSync.syncOrganization(orgId);
    expect(second.propertiesCreated).toBe(0);

    const { body } = await app.call('GET', `/v1/orgs/${orgId}/properties`, { token });
    expect(body.properties.map((p: { name: string }) => p.name).sort()).toEqual([
      'Berghaus Lärche',
      'Casa Azul Lisboa',
      'The Marlowe Charleston',
    ]);
    const lisbon = body.properties.find((p: { pmsPropertyId: string }) => p.pmsPropertyId === 'LIS');
    expect(lisbon).toMatchObject({
      status: 'draft',
      timeZone: 'Europe/Lisbon',
      currency: 'EUR',
      city: 'Lisboa',
    });

    const rooms = await app.call('GET', `/v1/orgs/${orgId}/properties/${lisbon.id}/rooms`, { token });
    expect(rooms.body.roomTypes).toHaveLength(3);
    const classic = rooms.body.roomTypes.find((r: { name: string }) => r.name === 'Classic Double');
    expect(classic.ratePlans.map((rp: { code: string }) => rp.code).sort()).toEqual([
      'BB',
      'CORP',
      'FLEX',
      'NRF',
    ]);
    const corp = classic.ratePlans.find((rp: { code: string }) => rp.code === 'CORP');
    expect(corp.paymentMode).toBeNull();
    expect(rooms.body.policies.some((p: { kind: string }) => p.kind === 'cancellation')).toBe(true);
    expect(fake.state.subscriptions.size).toBe(1);
  });

  it('keeps hotel edits but refreshes untouched fields on re-sync', async () => {
    const { body } = await app.call('GET', `/v1/orgs/${orgId}/properties`, { token });
    const lisbon = body.properties.find((p: { pmsPropertyId: string }) => p.pmsPropertyId === 'LIS');
    await app.call('PATCH', `/v1/orgs/${orgId}/properties/${lisbon.id}`, {
      token,
      body: { name: 'Casa Azul — Lapa' },
    });
    await app.container.services.pmsSync.syncOrganization(orgId);
    const after = await app.call('GET', `/v1/orgs/${orgId}/properties/${lisbon.id}`, { token });
    expect(after.body.name).toBe('Casa Azul — Lapa');
    expect(after.body.addressLine1).toBe('Rua das Janelas Verdes 32');
  });

  it('only quotes rate plans the hotel exposed, and caches them briefly', async () => {
    const { body } = await app.call('GET', `/v1/orgs/${orgId}/properties`, { token });
    const lisbon = body.properties.find((p: { pmsPropertyId: string }) => p.pmsPropertyId === 'LIS');
    const rooms = await app.call('GET', `/v1/orgs/${orgId}/properties/${lisbon.id}/rooms`, { token });
    const classic = rooms.body.roomTypes.find((r: { name: string }) => r.name === 'Classic Double');
    const plan = (code: string) => classic.ratePlans.find((rp: { code: string }) => rp.code === code);

    const corp = await app.call(
      'PATCH',
      `/v1/orgs/${orgId}/properties/${lisbon.id}/rate-plans/${plan('CORP').id}`,
      {
        token,
        body: { exposedToAgents: true },
      },
    );
    expect(corp.status).toBe(422);
    for (const code of ['FLEX', 'NRF']) {
      const res = await app.call(
        'PATCH',
        `/v1/orgs/${orgId}/properties/${lisbon.id}/rate-plans/${plan(code).id}`,
        {
          token,
          body: { exposedToAgents: true },
        },
      );
      expect(res.body.exposedToAgents).toBe(true);
    }

    const preview = await app.call(
      'GET',
      `/v1/orgs/${orgId}/properties/${lisbon.id}/offer-preview?checkIn=${checkIn}&checkOut=${checkOut}&adults=2`,
      { token },
    );
    expect(preview.status).toBe(200);
    expect(preview.body.offers.length).toBeGreaterThan(2);
    expect(preview.body.offers.some((o: { exposedToAgents: boolean }) => !o.exposedToAgents)).toBe(true);

    const search = { propertyId: lisbon.id, checkIn, checkOut, adults: 2, childrenAges: [] };
    await expect(app.container.services.offers.search(search)).rejects.toThrow(/Hotel not found/);
    const first = await app.container.services.offers.search(search, { allowUnpublished: true });
    expect(first.fromCache).toBe(false);
    expect(first.quotes.map((q) => q.ratePlanId).sort()).toEqual([plan('FLEX').id, plan('NRF').id].sort());
    const nrf = first.quotes.find((q) => q.ratePlanId === plan('NRF').id)!;
    expect(nrf.paymentMode).toBe('prepaid');
    expect(nrf.details.extras[0]?.label).toBe('Lisbon tourist tax');
    const second = await app.container.services.offers.search(search, { allowUnpublished: true });
    expect(second.fromCache).toBe(true);
    expect(second.quotes.map((q) => q.id).sort()).toEqual(first.quotes.map((q) => q.id).sort());
  });

  it('serializes token refreshes so rotating refresh tokens never collide', async () => {
    const client = await app.container.services.pmsConnections.clientFor(orgId);
    const results = await Promise.all(Array.from({ length: 5 }, () => client.listProperties()));
    expect(results.every((r) => r.length === 3)).toBe(true);
  });

  it('accepts Apaleo webhooks only with the secret token and de-duplicates them', async () => {
    const event = {
      topic: 'Reservation',
      type: 'created',
      id: 'ABC-1',
      accountId: 'DEMO',
      propertyId: 'LIS',
      timestamp: 1,
    };
    expect((await app.call('POST', '/webhooks/apaleo/wrong-token', { body: event })).status).toBe(401);
    const ok = await app.call('POST', '/webhooks/apaleo/dev-apaleo-webhook-token', { body: event });
    expect(ok.body).toEqual({ accepted: true });
    await app.call('POST', '/webhooks/apaleo/dev-apaleo-webhook-token', { body: event });
    const jobs = await app.container.db.system(
      async ({ tx }) =>
        (
          await tx.execute(
            `select payload from outbox where topic = 'job.enqueue' and payload->>'type' = 'pms.reservation-changed'`,
          )
        ).rows,
    );
    expect(jobs).toHaveLength(1);
    const health = await app.call('POST', '/webhooks/apaleo/dev-apaleo-webhook-token', {
      body: { topic: 'system', type: 'healthcheck' },
    });
    expect(health.body).toEqual({ accepted: true });
  });

  it('refuses to connect the same Apaleo account to a second organization', async () => {
    const other = await newOrg('Copycat Hotels');
    const location = await connect(other.token, other.orgId);
    expect(location).toBe(
      `http://web.test/app/${other.orgId}/settings/connections?apaleo=pms_account_in_use`,
    );
  });

  it('disconnects and revokes access', async () => {
    const res = await app.call('DELETE', `/v1/orgs/${orgId}/integrations/apaleo`, { token });
    expect(res.status).toBe(204);
    const status = await app.call('GET', `/v1/orgs/${orgId}/integrations/apaleo`, { token });
    expect(status.body).toMatchObject({ connected: false, status: 'revoked' });
    await expect(app.container.services.pmsConnections.clientFor(orgId)).rejects.toThrow(/not connected/);
    expect(fake.state.subscriptions.size).toBe(0);
  });
});

describe('OAuth state', () => {
  it('rejects a forged or expired state', async () => {
    const res = await app.call('GET', '/v1/integrations/apaleo/callback?code=x&state=forged.state');
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('http://web.test/app?apaleo=expired');
  });
});
