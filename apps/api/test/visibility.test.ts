import { createJobHandlers, PgJobRunner } from '@lodgent/application';
import type { VisibilityAnswer, VisibilityProvider } from '@lodgent/core';
import { sql } from '@lodgent/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, newOrg, type TestApp } from './helpers';

// biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON responses.
type Json = any;

/** A scripted assistant: answers by question, costs a fixed amount. */
function assistant(
  id: VisibilityProvider['id'],
  costCents: number,
  answer: (q: string) => Partial<VisibilityAnswer> | Error,
): VisibilityProvider & { asked: string[] } {
  const asked: string[] = [];
  return {
    id,
    label: id,
    model: `${id}-test`,
    simulated: false,
    asked,
    estimateCostCents: () => costCents,
    async ask(q) {
      asked.push(q);
      const a = answer(q);
      if (a instanceof Error) throw a;
      return { text: '', citations: [], model: `${id}-test`, costCents, searches: 1, ...a };
    },
  };
}

const claude = assistant('anthropic', 3, () => ({
  text: '1. **Memmo Alfama** – rooftop.\n2. **Casa Azul Lisboa** – townhouse in Lapa.\n3. **The Lumiares** – suites.',
  citations: [{ url: 'https://www.casaazul.example/', title: 'Casa Azul' }],
}));
const gpt = assistant('openai', 2, (q) =>
  q.includes('dog')
    ? new Error('OpenAI request failed (503)')
    : { text: '1. **Memmo Alfama**\n2. **Lisboa Plaza**' },
);

let app: TestApp;
let token: string;
let orgId: string;
let propertyId: string;
let base: string;

async function runJobs() {
  const runner = new PgJobRunner({
    db: app.container.db,
    clock: app.container.clock,
    logger: app.container.logger,
    handlers: createJobHandlers(app.container),
  });
  await app.container.services.outbox.dispatchBatch(50);
  for (let i = 0; i < 5; i++) if ((await runner.runOnce(10)) === 0) break;
}

beforeAll(async () => {
  app = await createTestApp(
    { WEB_BASE_URL: 'https://lodgent.example' },
    { visibilityProviders: [claude, gpt] },
  );
  ({ token, orgId } = await newOrg(app));
  const created = await app.call('POST', `/v1/orgs/${orgId}/properties`, {
    token,
    body: { name: 'Casa Azul Lisboa', city: 'Lisboa', countryCode: 'PT' },
  });
  propertyId = created.body.id;
  await app.call('PATCH', `/v1/orgs/${orgId}/properties/${propertyId}`, {
    token,
    body: { websiteUrl: 'https://casaazul.example' },
  });
  await app.call('PUT', `/v1/orgs/${orgId}/properties/${propertyId}/profile/attributes`, {
    token,
    body: { attributeCode: 'pets_allowed', value: true },
  });
  base = `/v1/orgs/${orgId}/properties/${propertyId}/visibility`;
});

afterAll(async () => {
  await app.close();
});

describe('AI visibility monitor', () => {
  it('suggests traveller questions from the profile', async () => {
    const { status, body } = await app.call('GET', base, { token });
    expect(status).toBe(200);
    expect(body.queries.map((q: Json) => q.text)).toEqual([
      'best boutique hotels in Lisboa',
      'dog-friendly hotels in Lisboa',
      'where to stay in Lisboa',
      'best hotels in Lisboa for a weekend',
    ]);
    expect(body.providers.map((p: Json) => p.id)).toEqual(['anthropic', 'openai']);
    expect(body).toMatchObject({
      summary: null,
      canRunNow: true,
      settings: { monthlyCapCents: 5000, spentThisMonthCents: 0 },
    });
  });

  it('lets the hotel add and remove questions', async () => {
    const added = await app.call('POST', `${base}/queries`, {
      token,
      body: { text: 'hotels near the Tagus with a courtyard' },
    });
    expect(added.status).toBe(201);
    expect(
      (
        await app.call('POST', `${base}/queries`, {
          token,
          body: { text: 'Hotels near the Tagus with a courtyard' },
        })
      ).status,
    ).toBe(409);
    expect((await app.call('POST', `${base}/queries`, { token, body: { text: 'hi' } })).status).toBe(400);
    expect((await app.call('DELETE', `${base}/queries/${added.body.id}`, { token })).status).toBe(200);
    expect((await app.call('GET', base, { token })).body.queries).toHaveLength(4);
  });

  it('runs every question past every assistant and analyses the answers', async () => {
    const started = await app.call('POST', `${base}/run`, { token });
    expect(started.status).toBe(202);
    await runJobs();
    expect(claude.asked).toHaveLength(4);
    expect(gpt.asked).toHaveLength(4);

    const { body } = await app.call('GET', base, { token });
    expect(body.latestRun).toMatchObject({
      status: 'completed',
      trigger: 'manual',
      questions: 4,
      costCents: 18,
    });
    expect(body.summary).toMatchObject({ answers: 7, mentionRate: 57, averageRank: 2, citedRate: 57 });
    expect(body.summary.byProvider).toEqual([
      { provider: 'anthropic', label: 'anthropic', answers: 4, mentionRate: 100, averageRank: 2 },
      { provider: 'openai', label: 'openai', answers: 3, mentionRate: 0, averageRank: null },
    ]);
    expect(body.topCompetitors[0]).toEqual({ name: 'Memmo Alfama', count: 7 });
    const failed = body.results.find((r: Json) => r.status === 'error');
    expect(failed).toMatchObject({
      provider: 'openai',
      queryText: 'dog-friendly hotels in Lisboa',
      error: 'OpenAI request failed (503)',
    });
    const hit = body.results.find((r: Json) => r.provider === 'anthropic');
    expect(hit).toMatchObject({
      mentioned: true,
      rank: 2,
      listSize: 3,
      ownSiteCited: true,
      excerpt: expect.stringContaining('Casa Azul Lisboa'),
    });
    expect(body.trend).toHaveLength(1);
    expect(body.settings.spentThisMonthCents).toBe(18);
    expect(body.recommendations.map((r: Json) => r.key)).toContain('publish');

    // Manual checks are limited to one an hour.
    const again = await app.call('POST', `${base}/run`, { token });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toMatch(/once an hour/);
  });

  it('stops at the monthly budget', async () => {
    const saved = await app.call('PUT', `/v1/orgs/${orgId}/visibility/settings`, {
      token,
      body: { monthlyCapCents: 24, enabled: true },
    });
    expect(saved.body).toEqual({ monthlyCapCents: 24, enabled: true });
    const before = claude.asked.length + gpt.asked.length;
    const run = await app.container.db.tenant(orgId, (r) => r.visibility.createRun(propertyId, 'schedule'));
    await app.container.services.visibility.run(orgId, run.id);
    const after = claude.asked.length + gpt.asked.length;
    // 18 spent; 6 cents left: one 3-cent and one 2-cent question fit, the next does not.
    expect(after - before).toBe(2);
    const stored = await app.container.db.tenant(orgId, (r) => r.visibility.getRun(run.id));
    expect(stored).toMatchObject({ status: 'capped', error: 'Stopped at the monthly budget.' });
    const { body } = await app.call('GET', base, { token });
    expect(body.settings.spentThisMonthCents).toBe(23);
  });

  it('schedules weekly runs for published hotels only and purges full answers after retention', async () => {
    expect(await app.container.services.visibility.scheduleAll()).toBe(0);
    await app.container.db.system(({ tx }) =>
      tx.execute(sql`update visibility_results set created_at = now() - interval '200 days'`),
    );
    expect(await app.container.services.visibility.purgeRawAnswers()).toBeGreaterThan(0);
    const rows = await app.container.db.system(
      async ({ tx }) =>
        (
          await tx.execute(
            sql`select count(*)::int as n from visibility_results where raw_answer is not null`,
          )
        ).rows,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('keeps each hotel group’s results private', async () => {
    const other = await newOrg(app, 'Other');
    expect(
      (
        await app.call('GET', `/v1/orgs/${other.orgId}/properties/${propertyId}/visibility`, {
          token: other.token,
        })
      ).status,
    ).toBe(404);
    const leaked = await app.container.db.tenant(
      other.orgId,
      async ({ tx }) => (await tx.execute(sql`select count(*)::int as n from visibility_results`)).rows,
    );
    expect(leaked[0]?.n).toBe(0);
  });
});
