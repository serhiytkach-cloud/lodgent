import type { AddressInfo } from 'node:net';
import { createFakeApaleo, type FakeApaleo } from '@lodgent/apaleo/fake';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectApaleo, createTestApp, newOrg, type TestApp } from './helpers';

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON responses.
type Json = any;

let fake: FakeApaleo;
let app: TestApp;
let fakeUrl: string;
let token: string;
let orgId: string;
let lisbon: Json;
let base: string;

const allRows = (profile: Json): Json[] => [
  ...profile.categories.flatMap((c: Json) => c.attributes),
  ...profile.rooms.flatMap((r: Json) => r.attributes),
];
const findRow = (profile: Json, code: string, roomTypeId: string | null = null) =>
  allRows(profile).find((a) => a.code === code && a.roomTypeId === roomTypeId);

beforeAll(async () => {
  fake = createFakeApaleo();
  await fake.app.listen({ port: 0, host: '127.0.0.1' });
  fakeUrl = `http://127.0.0.1:${(fake.app.server.address() as AddressInfo).port}`;
  app = await createTestApp({
    APALEO_IDENTITY_URL: fakeUrl,
    APALEO_API_URL: fakeUrl,
    APALEO_WEBHOOK_URL: fakeUrl,
    WEB_BASE_URL: 'http://web.test',
  });
  ({ token, orgId } = await newOrg(app));
  await connectApaleo(app, fakeUrl, token, orgId);
  await app.container.services.pmsSync.syncOrganization(orgId);
  const { body } = await app.call('GET', `/v1/orgs/${orgId}/properties`, { token });
  lisbon = body.properties.find((p: Json) => p.pmsPropertyId === 'LIS');
  base = `/v1/orgs/${orgId}/properties/${lisbon.id}`;
});

afterAll(async () => {
  await app.close();
  await fake.app.close();
});

describe('attribute profile', () => {
  it('maps PMS data to suggestions with PMS provenance', async () => {
    const counts = await app.container.services.catalog.mapPmsAttributes(orgId, lisbon.id);
    expect(counts?.created).toBeGreaterThan(5);
    // Idempotent: a second run changes nothing.
    const again = await app.container.services.catalog.mapPmsAttributes(orgId, lisbon.id);
    expect(again).toMatchObject({ created: 0, updated: 0 });

    const { status, body } = await app.call('GET', `${base}/profile`, { token });
    expect(status).toBe(200);
    const breakfast = findRow(body, 'breakfast_included_rate');
    expect(breakfast.effective).toBeNull();
    expect(breakfast.suggestions[0]).toMatchObject({ source: 'pms', value: true, status: 'suggested' });
    expect(breakfast.suggestions[0].evidence[0].url).toMatch(/^pms:\/\/apaleo\/rate-plans\//);

    const deluxe = body.rooms.find((r: Json) => r.name === 'Deluxe River View');
    const size = deluxe.attributes.find((a: Json) => a.code === 'room_size_sqm');
    expect(size.suggestions[0]).toMatchObject({ value: 26, source: 'pms' });
    expect(body.pendingSuggestions).toBeGreaterThan(5);
  });

  it('imports the hotel website: robots.txt respected, every suggestion quoted from its page', async () => {
    const noUrl = await app.call('POST', `${base}/profile/import-website`, { token });
    expect(noUrl.status).toBe(400);

    await app.call('PATCH', base, { token, body: { websiteUrl: `${fakeUrl}/sites/lis/` } });
    const started = await app.call('POST', `${base}/profile/import-website`, { token });
    expect(started.status).toBe(202);
    const dup = await app.call('POST', `${base}/profile/import-website`, { token });
    expect(dup.status).toBe(409);

    await app.container.services.websiteImport.run(orgId, started.body.crawlId);
    const { body } = await app.call('GET', `${base}/profile`, { token });
    expect(body.crawl).toMatchObject({ status: 'succeeded', pagesFetched: 5, model: 'keyword-matcher-v1' });
    expect(body.crawl.stats.suggestions).toBeGreaterThan(10);

    const pages = await app.container.db.tenant(orgId, (r) => r.crawls.pages(started.body.crawlId));
    const urls = pages.map((p) => new URL(p.url).pathname);
    expect(urls).toContain('/sites/lis/rooms/');
    expect(urls.some((u) => u.includes('/admin/'))).toBe(false);
    expect(fake.state.requests.some((r) => r.url.includes('/admin/'))).toBe(false);

    // Every website suggestion's quote appears on the page it cites.
    const byUrl = new Map(pages.map((p) => [p.url, p.text]));
    const websiteSuggestions = allRows(body).flatMap((a) =>
      a.suggestions.filter((s: Json) => s.source === 'website'),
    );
    expect(websiteSuggestions.length).toBeGreaterThan(10);
    for (const s of websiteSuggestions) {
      for (const e of s.evidence) expect(byUrl.get(e.url)).toContain(e.snippet.slice(0, 40));
    }

    expect(findRow(body, 'parking').suggestions[0]).toMatchObject({ value: 'paid', source: 'website' });
    expect(findRow(body, 'green_certified').suggestions[0].value).toBe(true);
    const classic = body.rooms.find((r: Json) => r.name === 'Classic Double');
    expect(
      classic.attributes.find((a: Json) => a.code === 'rain_shower').suggestions.map((s: Json) => s.source),
    ).toEqual(expect.arrayContaining(['website', 'pms']));
    expect(
      body.descriptions.some((d: Json) => d.roomTypeId === null && d.evidenceUrl.endsWith('/sites/lis/')),
    ).toBe(true);
  });

  it('drops suggestions whose quote is not on the cited page', async () => {
    const svc = app.container.services.websiteImport;
    // Run the import again with an extractor that invents a quote.
    const lying = {
      name: 'liar',
      source: 'ai_extracted' as const,
      extract: async (input: { pages: { url: string }[] }) => ({
        model: 'liar',
        attributes: [
          {
            code: 'outdoor_pool',
            value: true,
            confidence: 0.99,
            roomTypeName: null,
            evidence: { url: input.pages[0]!.url, snippet: 'Our rooftop infinity pool is open all year.' },
          },
          {
            code: 'free_wifi',
            value: true,
            confidence: 0.9,
            roomTypeName: null,
            evidence: { url: input.pages[0]!.url, snippet: 'Free Wi-Fi is available throughout the house.' },
          },
        ],
        propertyDescription: null,
        roomDescriptions: [],
      }),
    };
    const original = (svc as unknown as { deps: { extraction: unknown } }).deps.extraction;
    (svc as unknown as { deps: { extraction: unknown } }).deps.extraction = lying;
    try {
      const started = await app.call('POST', `${base}/profile/import-website`, { token });
      await svc.run(orgId, started.body.crawlId);
    } finally {
      (svc as unknown as { deps: { extraction: unknown } }).deps.extraction = original;
    }
    const { body } = await app.call('GET', `${base}/profile`, { token });
    expect(body.crawl.stats).toMatchObject({ suggestions: 1, droppedUnverified: 1 });
    expect(findRow(body, 'outdoor_pool').suggestions).toHaveLength(0);
    expect(findRow(body, 'free_wifi').suggestions.map((s: Json) => s.source)).toContain('ai_extracted');
  });

  it('reviews in bulk; the hotel’s own value wins and can be cleared', async () => {
    const { body } = await app.call('GET', `${base}/profile`, { token });
    const pick = (code: string, roomTypeId: string | null = null) =>
      findRow(body, code, roomTypeId).suggestions[0].assignmentId;
    const approve = [
      'breakfast_included_rate',
      'breakfast_available',
      'free_wifi',
      'front_desk_24h',
      'luggage_storage',
      'boutique',
    ].map((c) => pick(c));
    const reject = [pick('elevator')];
    const res = await app.call('POST', `${base}/profile/review`, { token, body: { approve, reject } });
    expect(res.body).toEqual({ approved: 6, rejected: 1 });

    const both = await app.call('POST', `${base}/profile/review`, {
      token,
      body: { approve: reject, reject },
    });
    expect(both.status).toBe(400);

    let after = (await app.call('GET', `${base}/profile`, { token })).body;
    expect(findRow(after, 'free_wifi').effective).toMatchObject({ value: true });
    expect(findRow(after, 'elevator').effective).toBeNull();
    expect(after.pendingSuggestions).toBeLessThan(body.pendingSuggestions);

    // Hotel sets parking itself: it overrides the website's "paid".
    expect(
      (
        await app.call('PUT', `${base}/profile/attributes`, {
          token,
          body: { attributeCode: 'parking', value: 'valet' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.call('PUT', `${base}/profile/attributes`, {
          token,
          body: { attributeCode: 'parking', value: 'helipad' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.call('PUT', `${base}/profile/attributes`, {
          token,
          body: { attributeCode: 'balcony', value: true },
        })
      ).status,
    ).toBe(400); // room-level attribute without a room
    after = (await app.call('GET', `${base}/profile`, { token })).body;
    expect(findRow(after, 'parking').effective).toMatchObject({ value: 'valet', source: 'hotel' });

    await app.call('PUT', `${base}/profile/attributes`, {
      token,
      body: { attributeCode: 'parking', value: null },
    });
    after = (await app.call('GET', `${base}/profile`, { token })).body;
    expect(findRow(after, 'parking').effective).toBeNull();
  });

  it('accepts a suggested description', async () => {
    const { body } = await app.call('GET', `${base}/profile`, { token });
    const suggestion = body.descriptions.find((d: Json) => d.roomTypeId === null);
    const res = await app.call('POST', `${base}/profile/descriptions/${suggestion.id}`, {
      token,
      body: { accept: true },
    });
    expect(res.status).toBe(200);
    const property = await app.call('GET', base, { token });
    expect(property.body.description).toBe(suggestion.text);
    const again = (await app.call('GET', `${base}/profile`, { token })).body;
    expect(again.descriptions.find((d: Json) => d.id === suggestion.id)).toBeUndefined();
  });

  it('refuses to publish until ready, then publishes with JSON-LD and a public profile', async () => {
    const before = await app.call('GET', `${base}/publish`, { token });
    expect(before.body.status).toBe('draft');
    expect(before.body.canPublish).toBe(false);
    expect(before.body.checks.find((c: Json) => c.key === 'rate_plans').ok).toBe(false);
    const refused = await app.call('POST', `${base}/publish`, { token });
    expect(refused.status).toBe(422);
    expect((await app.call('GET', `/v1/public/hotels/${lisbon.slug}`)).status).toBe(404);

    const rooms = await app.call('GET', `${base}/rooms`, { token });
    for (const rt of rooms.body.roomTypes) {
      const flex = rt.ratePlans.find((rp: Json) => rp.code === 'FLEX');
      await app.call('PATCH', `${base}/rate-plans/${flex.id}`, { token, body: { exposedToAgents: true } });
    }
    const ready = await app.call('GET', `${base}/publish`, { token });
    expect(ready.body.canPublish).toBe(true);
    expect(ready.body.completeness).toBeGreaterThan(0);

    const published = await app.call('POST', `${base}/publish`, { token });
    expect(published.status).toBe(200);
    expect(published.body.status).toBe('published');
    expect((await app.call('POST', `${base}/publish`, { token })).status).toBe(409);

    const ld = published.body.jsonLd;
    expect(ld['@type']).toBe('Hotel');
    expect(ld.name).toBe('Casa Azul Lisboa');
    expect(ld.url).toBe(`${fakeUrl}/sites/lis/`); // the hotel's own site
    expect(ld.sameAs).toEqual([`http://web.test/hotels/${lisbon.slug}`]);
    expect(JSON.stringify(ld.amenityFeature)).toContain('Free Wi-Fi');
    expect(ld.containsPlace.length).toBe(3);
    // Rejected and unreviewed values never reach the public profile.
    expect(JSON.stringify(ld)).not.toContain('Elevator');

    const pub = await app.call('GET', `/v1/public/hotels/${lisbon.slug}`);
    expect(pub.status).toBe(200);
    expect(pub.body.profile.name).toBe('Casa Azul Lisboa');
    expect(
      pub.body.profile.roomTypes.every((r: Json) =>
        r.ratePlans.every((rp: Json) => rp.name !== 'Corporate rate'),
      ),
    ).toBe(true);
    expect(pub.body.profile.attributes.map((a: Json) => a.code)).toEqual(
      expect.arrayContaining(['free_wifi', 'boutique']),
    );
    expect((await app.call('GET', `/v1/public/hotels/${lisbon.id}`)).status).toBe(200);

    const embeddings = await app.container.db.tenant(orgId, (r) => r.embeddings.listForProperty(lisbon.id));
    expect(embeddings.length).toBe(4); // the property plus three rooms

    const unpublished = await app.call('POST', `${base}/unpublish`, { token });
    expect(unpublished.body.status).toBe('unpublished');
    expect((await app.call('GET', `/v1/public/hotels/${lisbon.slug}`)).status).toBe(404);
  });

  it('hides other organizations’ profiles', async () => {
    const other = await newOrg(app, 'Someone Else');
    expect(
      (
        await app.call('GET', `/v1/orgs/${other.orgId}/properties/${lisbon.id}/profile`, {
          token: other.token,
        })
      ).status,
    ).toBe(404);
    expect((await app.call('GET', `${base}/profile`, { token: other.token })).status).toBe(404);
  });
});
