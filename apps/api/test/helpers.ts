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
    options?: { token?: string; body?: unknown; headers?: Record<string, string> },
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
