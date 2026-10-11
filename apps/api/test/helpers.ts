import { randomUUID } from 'node:crypto';
import { type Adapters, createContainer, loadConfig, MemoryMailer } from '@lodgent/application';
import { cloneDatabase } from '@lodgent/db/testing';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { inject } from 'vitest';
import { buildApp } from '../src/app';

export interface TestApp {
  server: FastifyInstance;
  container: ReturnType<typeof createContainer>;
  router: Awaited<ReturnType<typeof buildApp>>['router'];
  mailer: MemoryMailer;
  /** Signs in (dev auth) and returns a bearer token. */
  login(email?: string): Promise<{ token: string; email: string }>;
  /** `inject` with an optional bearer token; returns status and parsed JSON. */
  call(
    method: InjectOptions['method'],
    url: string,
    options?: { token?: string; body?: unknown; headers?: Record<string, string>; remoteAddress?: string },
    // biome-ignore lint/suspicious/noExplicitAny: tests read arbitrary JSON responses.
  ): Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  close(): Promise<void>;
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.com`;
}

export async function createTestApp(
  env: Record<string, string> = {},
  overrides: Partial<Adapters> = {},
): Promise<TestApp> {
  // Each test file gets its own database cloned from the migrated template, so background work
  // (outbox dispatch, jobs) in one file never sees another file's rows.
  const database = await cloneDatabase(inject('databaseUrl'));
  const config = loadConfig({
    APP_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: database.url,
    ...env,
  });
  const mailer = new MemoryMailer();
  const container = createContainer(config, { mailer, name: 'api-test', ...overrides });
  await container.init();
  const { server, router } = await buildApp(container);
  await server.ready();

  const call: TestApp['call'] = async (method, url, options = {}) => {
    const res = await server.inject({
      method,
      url,
      headers: {
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      payload: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
    });
    let body: unknown = null;
    if (res.body) {
      try {
        body = JSON.parse(res.body);
      } catch {
        body = res.body;
      }
    }
    return { status: res.statusCode, body, headers: res.headers };
  };

  return {
    server,
    container,
    router,
    mailer,
    call,
    async login(email = uniqueEmail()) {
      const res = await call('POST', '/v1/auth/dev/login', { body: { email } });
      if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.body)}`);
      return { token: res.body.token as string, email };
    },
    async close() {
      await server.close();
      await container.close();
      await database.drop();
    },
  };
}

/** Runs the Apaleo OAuth dance against the fake server the way a browser would; returns the final redirect. */
export async function connectApaleo(
  app: TestApp,
  fakeUrl: string,
  token: string,
  orgId: string,
  account = 'DEMO',
): Promise<string> {
  const start = await app.call('POST', `/v1/orgs/${orgId}/integrations/apaleo/authorize`, { token });
  if (start.status !== 200) throw new Error(`authorize failed: ${JSON.stringify(start.body)}`);
  const consent = new URL(start.body.url);
  const approve = await fetch(
    `${fakeUrl}/connect/authorize/approve?${new URLSearchParams({
      redirect_uri: consent.searchParams.get('redirect_uri')!,
      state: consent.searchParams.get('state')!,
      account,
    })}`,
    { redirect: 'manual' },
  );
  const callback = new URL(approve.headers.get('location')!);
  const res = await app.call('GET', `${callback.pathname}${callback.search}`);
  if (res.status !== 303) throw new Error(`callback failed: ${JSON.stringify(res.body)}`);
  return String(res.headers.location);
}

/** Creates an org owned by a fresh user. */
export async function newOrg(app: TestApp, name = 'Demo Boutique Hotels') {
  const owner = await app.login();
  const org = await app.call('POST', '/v1/orgs', { token: owner.token, body: { name } });
  return { token: owner.token, email: owner.email, orgId: org.body.id as string };
}

/**
 * Takes a synced property live: approves its PMS suggestions, sets the given attribute values as
 * the hotel, sells the given rate plan codes via agents, and publishes.
 */
export async function publishProperty(
  app: TestApp,
  token: string,
  orgId: string,
  propertyId: string,
  options: { values?: Record<string, boolean | number | string>; ratePlanCodes?: string[] } = {},
): Promise<void> {
  const base = `/v1/orgs/${orgId}/properties/${propertyId}`;
  await app.container.services.catalog.mapPmsAttributes(orgId, propertyId);
  const profile = await app.call('GET', `${base}/profile`, { token });
  const rows = [
    ...profile.body.categories.flatMap((c: { attributes: unknown[] }) => c.attributes),
    ...profile.body.rooms.flatMap((r: { attributes: unknown[] }) => r.attributes),
  ] as { suggestions: { assignmentId: string; source: string }[] }[];
  const approve = rows.flatMap((r) =>
    r.suggestions.filter((s) => s.source === 'pms').map((s) => s.assignmentId),
  );
  if (approve.length > 0)
    await app.call('POST', `${base}/profile/review`, { token, body: { approve, reject: [] } });
  for (const [attributeCode, value] of Object.entries(options.values ?? {})) {
    const res = await app.call('PUT', `${base}/profile/attributes`, {
      token,
      body: { attributeCode, value },
    });
    if (res.status !== 200) throw new Error(`set ${attributeCode} failed: ${JSON.stringify(res.body)}`);
  }
  const rooms = await app.call('GET', `${base}/rooms`, { token });
  for (const rt of rooms.body.roomTypes as { ratePlans: { id: string; code: string }[] }[]) {
    for (const rp of rt.ratePlans.filter((p) => (options.ratePlanCodes ?? ['FLEX']).includes(p.code))) {
      await app.call('PATCH', `${base}/rate-plans/${rp.id}`, { token, body: { exposedToAgents: true } });
    }
  }
  const published = await app.call('POST', `${base}/publish`, { token });
  if (published.status !== 200) throw new Error(`publish failed: ${JSON.stringify(published.body)}`);
}
