import type { AddressInfo } from 'node:net';
import { createFakeApaleo, type FakeApaleo } from '@lodgent/apaleo/fake';
import { sql } from '@lodgent/db';
import { addDays, localDateAt } from '@lodgent/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectApaleo, createTestApp, newOrg, publishProperty, type TestApp } from './helpers';

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON responses.
type Json = any;

let fake: FakeApaleo;
let app: TestApp;
let apiUrl: string;
let orgId: string;
let hotels: Record<'LIS' | 'SEE' | 'CHS', string>;

const checkIn = addDays(localDateAt(new Date(), 'Europe/Lisbon'), 30);
const checkOut = addDays(checkIn, 2);

beforeAll(async () => {
  fake = createFakeApaleo();
  await fake.app.listen({ port: 0, host: '127.0.0.1' });
  const fakeUrl = `http://127.0.0.1:${(fake.app.server.address() as AddressInfo).port}`;
  app = await createTestApp({
    APALEO_IDENTITY_URL: fakeUrl,
    APALEO_API_URL: fakeUrl,
    APALEO_WEBHOOK_URL: fakeUrl,
    WEB_BASE_URL: 'http://web.test',
    // Every hold creation re-checks its offer only after this window.
    OFFER_CACHE_TTL_SECONDS: '60',
  });
  await app.server.listen({ port: 0, host: '127.0.0.1' });
  apiUrl = `http://127.0.0.1:${(app.server.server.address() as AddressInfo).port}`;

  const owner = await newOrg(app);
  orgId = owner.orgId;
  await connectApaleo(app, fakeUrl, owner.token, orgId);
  await app.container.services.pmsSync.syncOrganization(orgId);
  const { body } = await app.call('GET', `/v1/orgs/${orgId}/properties`, { token: owner.token });
  const id = (code: string) => body.properties.find((p: Json) => p.pmsPropertyId === code).id as string;
  hotels = { LIS: id('LIS'), SEE: id('SEE'), CHS: id('CHS') };

  await publishProperty(app, owner.token, orgId, hotels.LIS, {
    values: { free_wifi: true, boutique: true, historic_building: true, river_view: true, sauna: false },
    ratePlanCodes: ['FLEX', 'NRF'],
  });
  await publishProperty(app, owner.token, orgId, hotels.SEE, {
    values: {
      sauna: true,
      spa: true,
      pets_allowed: true,
      free_wifi: true,
      mountain_view: true,
      parking: 'free',
    },
  });
  await publishProperty(app, owner.token, orgId, hotels.CHS, {
    values: {
      free_wifi: true,
      rooftop_bar: true,
      pets_allowed: true,
      parking: 'valet',
      fitness_center: true,
    },
  });
});

afterAll(async () => {
  await app.close();
  await fake.app.close();
});

describe('REST agent API', () => {
  it('searches by destination with fuzzy names and explains the ranking', async () => {
    const res = await app.call('POST', '/v1/agent/search', { body: { destination: 'Lisbon' } });
    expect(res.status).toBe(200);
    expect(res.body.results.map((r: Json) => r.name)).toEqual(['Casa Azul Lisboa']);
    const [first] = res.body.results;
    expect(first).toMatchObject({ rank: 1, profileUrl: expect.stringContaining('http://web.test/hotels/') });
    expect(first.cheapestOffer).toBeNull();
    expect(first.why.length).toBeGreaterThan(0);

    const austria = await app.call('POST', '/v1/agent/search', { body: { destination: 'Tyrol, Austria' } });
    expect(austria.body.results.map((r: Json) => r.name)).toEqual(['Berghaus Lärche']);
    const nowhere = await app.call('POST', '/v1/agent/search', { body: { destination: 'Reykjavik' } });
    expect(nowhere.body.results).toEqual([]);
    expect(nowhere.body.notes.join(' ')).toContain('No published hotels match');
  });

  it('applies hard requirements from plain phrases and prices results live', async () => {
    const res = await app.call('POST', '/v1/agent/search', {
      body: {
        checkIn,
        checkOut,
        adults: 2,
        mustHave: ['dog friendly', 'free wifi'],
        niceToHave: ['sauna', 'rooftop bar'],
        preferences: 'quiet mountain hideaway',
        budgetPerNight: { amount: 300, currency: 'EUR' },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.interpreted.mustHave.map((m: Json) => m.codes)).toEqual([
      ['pets_allowed', 'dogs_allowed'],
      ['free_wifi'],
    ]);
    const names = res.body.results.map((r: Json) => r.name);
    expect(names).toContain('Berghaus Lärche');
    expect(names).toContain('The Marlowe Charleston');
    expect(names).not.toContain('Casa Azul Lisboa'); // no pets confirmed
    expect(res.body.excludedCount).toBe(1);
    const see = res.body.results.find((r: Json) => r.name === 'Berghaus Lärche');
    expect(see.cheapestOffer).toMatchObject({ paymentMode: 'pay_at_hotel', total: { currency: 'EUR' } });
    expect(see.why.join(' ')).toMatch(/Has Pets allowed, Free Wi-Fi, confirmed by the hotel/);
    expect(see.matched.niceToHave).toContain('sauna');

    // Same request, same order.
    const again = await app.call('POST', '/v1/agent/search', {
      body: {
        checkIn,
        checkOut,
        mustHave: ['dog friendly', 'free wifi'],
        niceToHave: ['sauna', 'rooftop bar'],
        preferences: 'quiet mountain hideaway',
        budgetPerNight: { amount: 300, currency: 'EUR' },
      },
    });
    expect(again.body.results.map((r: Json) => r.hotelId)).toEqual(
      res.body.results.map((r: Json) => r.hotelId),
    );
  });

  it('treats unknown requirements as preferences and validates dates', async () => {
    const res = await app.call('POST', '/v1/agent/search', {
      body: { destination: 'Seefeld', mustHave: ['sauna', 'vibe like a cabin from a fairy tale'] },
    });
    expect(res.body.interpreted.treatedAsPreferences).toEqual(['vibe like a cabin from a fairy tale']);
    expect(res.body.results).toHaveLength(1);
    const bad = await app.call('POST', '/v1/agent/search', { body: { checkIn } });
    expect(bad.status).toBe(400);
    const inverted = await app.call('POST', '/v1/agent/search', {
      body: { checkIn: checkOut, checkOut: checkIn },
    });
    expect(inverted.status).toBe(400);
  });

  it('returns profiles and live offers for published hotels only', async () => {
    const hotel = await app.call('GET', `/v1/agent/hotels/${hotels.LIS}`);
    expect(hotel.status).toBe(200);
    expect(hotel.body.hotel.attributes.map((a: Json) => a.code)).toContain('river_view');

    const offers = await app.call(
      'GET',
      `/v1/agent/hotels/${hotels.LIS}/offers?checkIn=${checkIn}&checkOut=${checkOut}&adults=2`,
    );
    expect(offers.status).toBe(200);
    const plans = new Set(offers.body.offers.map((o: Json) => o.ratePlan.name));
    expect(plans).toEqual(new Set(['Flexible rate', 'Non-refundable saver']));
    expect(offers.body.offers[0].total.formatted).toMatch(/^€/);

    const stranger = await app.call('POST', `/v1/orgs/${orgId}/properties/${hotels.CHS}/unpublish`, {
      token: (await app.login()).token,
    });
    expect(stranger.status).toBe(404);
    expect((await app.call('GET', `/v1/agent/hotels/${hotels.CHS}`)).status).toBe(200);
    expect((await app.call('GET', '/v1/agent/hotels/not-a-hotel')).status).toBe(404);
  });

  it('holds a room, returns a checkout link and tracks status', async () => {
    const offers = await app.call(
      'GET',
      `/v1/agent/hotels/${hotels.SEE}/offers?checkIn=${checkIn}&checkOut=${checkOut}`,
    );
    const offer = offers.body.offers[0];
    const hold = await app.call('POST', '/v1/agent/holds', { body: { offerId: offer.offerId } });
    expect(hold.status).toBe(201);
    expect(hold.body).toMatchObject({
      status: 'active',
      hotel: { id: hotels.SEE, name: 'Berghaus Lärche' },
      total: offer.total,
      paymentMode: 'pay_at_hotel',
      dueNow: { amount: 0 },
      booking: null,
    });
    expect(hold.body.checkoutUrl).toMatch(/^http:\/\/web\.test\/checkout\/[\w-]+\.[\w-]+$/);
    const token = hold.body.checkoutUrl.split('/checkout/')[1];
    expect(app.container.services.agent.holdIdFromCheckoutToken(token)).toBe(hold.body.holdId);
    expect(app.container.services.agent.holdIdFromCheckoutToken(`${token}x`)).toBeNull();

    const status = await app.call('GET', `/v1/agent/holds/${hold.body.holdId}`);
    expect(status.body.status).toBe('active');

    // The fee is frozen on the hold at the property's rate (2% default).
    const row = await app.container.db.tenant(orgId, (r) => r.holds.get(hold.body.holdId));
    expect(row?.feeAmount).toBe(Math.round(offer.total.amount * 0.02));

    // Expiry.
    await app.container.db.system(({ tx }) =>
      tx.execute(
        sql`update holds set expires_at = now() - interval '1 minute' where id = ${hold.body.holdId}`,
      ),
    );
    const expired = await app.call('GET', `/v1/agent/holds/${hold.body.holdId}`);
    expect(expired.body).toMatchObject({ status: 'expired', checkoutUrl: null });
  });

  it('never holds more rooms than are available', async () => {
    const offers = await app.call(
      'GET',
      `/v1/agent/hotels/${hotels.SEE}/offers?checkIn=${checkIn}&checkOut=${checkOut}`,
    );
    const loft = offers.body.offers.find((o: Json) => o.roomType.name === 'Larch Loft');
    expect(loft.availableRooms).toBe(2);
    const results = await Promise.all(
      [1, 2, 3].map(() => app.call('POST', '/v1/agent/holds', { body: { offerId: loft.offerId } })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409]);
    expect(results.find((r) => r.status === 409)?.body.error.code).toBe('offer_unavailable');
  });

  it('re-checks stale offers: expired, unavailable and changed prices', async () => {
    const offers = await app.call(
      'GET',
      `/v1/agent/hotels/${hotels.LIS}/offers?checkIn=${checkIn}&checkOut=${checkOut}`,
    );
    const [a, b] = offers.body.offers;
    await app.container.db.system(({ tx }) =>
      tx.execute(
        sql`update offer_quotes set expires_at = now() - interval '1 second' where id = ${a.offerId}`,
      ),
    );
    const expired = await app.call('POST', '/v1/agent/holds', { body: { offerId: a.offerId } });
    expect(expired.status).toBe(409);
    expect(expired.body.error.code).toBe('offer_expired');

    // An old quote (outside the cache window) whose price no longer matches the PMS.
    await app.container.db.system(async ({ tx }) => {
      await tx.execute(
        sql`update offer_quotes set created_at = now() - interval '5 minutes' where property_id = ${hotels.LIS}`,
      );
      await tx.execute(
        sql`update offer_quotes set total_amount = total_amount - 500 where id = ${b.offerId}`,
      );
    });
    const changed = await app.call('POST', '/v1/agent/holds', { body: { offerId: b.offerId } });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('price_changed');
    expect(changed.body.error.message).toMatch(/The price changed from €[\d.,]+ to €[\d.,]+/);
    const retry = await app.call('POST', '/v1/agent/holds', {
      body: { offerId: changed.body.error.details.newOfferId },
    });
    expect(retry.status).toBe(201);

    expect(
      (
        await app.call('POST', '/v1/agent/holds', {
          body: { offerId: '00000000-0000-4000-8000-000000000000' },
        })
      ).status,
    ).toBe(404);
  });

  it('logs activity without guest data and attributes it to partners', async () => {
    const partner = await app.container.services.agentClients.create({ name: 'Trip Planner AI' });
    const bad = await app.call('POST', '/v1/agent/search', {
      body: { destination: 'Lisbon' },
      headers: { 'x-api-key': 'lodg_live_not-a-real-key' },
    });
    expect(bad.status).toBe(401);
    const res = await app.call('POST', '/v1/agent/search', {
      body: {
        destination: 'Charleston',
        preferences: 'anniversary trip for jane.doe@example.com, call +1 843 555 0100',
        mustHave: ['pets allowed'],
      },
      headers: { authorization: `Bearer ${partner.apiKey}`, 'x-agent-name': 'PlannerBot' },
    });
    expect(res.status).toBe(200);

    const rows = await app.container.db.system(
      async ({ tx }) =>
        (await tx.execute(sql`select * from agent_queries where agent_client_id = ${partner.id}`)).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: 'search_hotels',
      destination: 'Charleston',
      must_have_codes: ['pets_allowed'],
      has_preferences: true,
      client_name: 'PlannerBot',
      channel: 'rest',
    });
    const everything = await app.container.db.system(
      async ({ tx }) => (await tx.execute(sql`select row_to_json(q)::text as j from agent_queries q`)).rows,
    );
    const dump = everything.map((r) => String(r.j)).join('\n');
    // (The phone number is matched whole: a bare "555" also occurs in random ids and timestamps.)
    expect(dump).not.toMatch(/jane|example\.com|843 555 0100|anniversary/);

    // The hotel sees its own funnel events.
    const events = await app.container.db.tenant(
      orgId,
      async ({ tx }) =>
        (await tx.execute(sql`select kind, count(*)::int as n from agent_events group by kind`)).rows,
    );
    const kinds = Object.fromEntries(events.map((e) => [e.kind, e.n]));
    expect(kinds.search_impression).toBeGreaterThan(3);
    expect(kinds.offers_view).toBeGreaterThan(1);
    expect(kinds.hold_created).toBeGreaterThan(1);

    const other = await newOrg(app, 'Other');
    const leaked = await app.container.db.tenant(
      other.orgId,
      async ({ tx }) => (await tx.execute(sql`select count(*)::int as n from agent_events`)).rows,
    );
    expect(leaked[0]?.n).toBe(0);
    await expect(
      app.container.db.tenant(other.orgId, ({ tx }) => tx.execute(sql`select * from agent_queries`)),
    ).rejects.toThrow();
  });

  it('rate-limits anonymous callers per IP', async () => {
    const limit = app.container.config.rateLimits.anonymousPerMinute;
    let last = 0;
    for (let i = 0; i <= limit; i++) {
      last = (await app.call('GET', `/v1/agent/hotels/${hotels.LIS}`, { remoteAddress: '10.9.8.7' })).status;
    }
    expect(last).toBe(429);
    expect(
      (await app.call('GET', `/v1/agent/hotels/${hotels.LIS}`, { remoteAddress: '10.9.8.8' })).status,
    ).toBe(200);
  });

  it('publishes the agent API as OpenAPI 3.1', async () => {
    const { body } = await app.call('GET', '/openapi.json');
    expect(body.openapi).toMatch(/^3\.1/);
    expect(Object.keys(body.paths).sort()).toEqual([
      '/v1/agent/holds',
      '/v1/agent/holds/{holdId}',
      '/v1/agent/hotels/{hotelId}',
      '/v1/agent/hotels/{hotelId}/offers',
      '/v1/agent/search',
    ]);
    expect(
      body.paths['/v1/agent/search'].post.requestBody.content['application/json'].schema.properties.mustHave,
    ).toBeDefined();
  });
});

describe('MCP server', () => {
  async function connect(mode: 'auto' | undefined) {
    const client = new Client(
      { name: 'lodgent-test', version: '1.0.0' },
      mode ? { versionNegotiation: { mode } } : undefined,
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${apiUrl}/mcp`)));
    return client;
  }

  it.each([
    ['legacy handshake', undefined],
    ['2026 protocol', 'auto' as const],
  ])('lists the five tools (%s)', async (_label, mode) => {
    const client = await connect(mode);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'create_hold',
      'get_hold_status',
      'get_hotel',
      'get_offers',
      'search_hotels',
    ]);
    const search = tools.find((t) => t.name === 'search_hotels')!;
    expect(JSON.stringify(search.inputSchema)).toContain('mustHave');
    expect(search.annotations?.readOnlyHint).toBe(true);
    expect(client.getInstructions()).toContain('never ask for or send payment card details');
    await client.close();
  });

  it('searches, quotes and holds over MCP', async () => {
    const client = await connect('auto');
    const search = await client.callTool({
      name: 'search_hotels',
      arguments: { destination: 'Seefeld', checkIn, checkOut, mustHave: ['sauna'] },
    });
    expect(search.isError).toBeFalsy();
    const found = search.structuredContent as Json;
    expect(found.results[0].name).toBe('Berghaus Lärche');
    expect((search.content as Json)[0].text).toMatch(/^1 hotel\(s\):\n1\. Berghaus Lärche/);

    const offers = await client.callTool({
      name: 'get_offers',
      arguments: { hotelId: found.results[0].hotelId, checkIn, checkOut, adults: 2 },
    });
    const offerId = (offers.structuredContent as Json).offers[0].offerId;
    const hold = await client.callTool({ name: 'create_hold', arguments: { offerId } });
    expect(hold.isError).toBeFalsy();
    const dto = hold.structuredContent as Json;
    expect(dto.checkoutUrl).toContain('/checkout/');
    const status = await client.callTool({ name: 'get_hold_status', arguments: { holdId: dto.holdId } });
    expect((status.structuredContent as Json).status).toBe('active');

    const rows = await app.container.db.system(
      async ({ tx }) => (await tx.execute(sql`select channel from holds where id = ${dto.holdId}`)).rows,
    );
    expect(rows[0]?.channel).toBe('mcp');
    await client.close();
  });

  it('returns recoverable tool errors', async () => {
    const client = await connect('auto');
    const missing = await client.callTool({
      name: 'create_hold',
      arguments: { offerId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(missing.isError).toBe(true);
    expect((missing.content as Json)[0].text).toMatch(/^not_found: /);
    const invalid = await client.callTool({ name: 'get_offers', arguments: { hotelId: 'nope' } });
    expect(invalid.isError).toBe(true);
    await client.close();
  });

  it('rejects an invalid partner key', async () => {
    const client = new Client({ name: 'lodgent-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${apiUrl}/mcp`), {
      requestInit: { headers: { 'x-api-key': 'lodg_live_bogus' } },
    });
    await expect(client.connect(transport)).rejects.toThrow();
  });
});
