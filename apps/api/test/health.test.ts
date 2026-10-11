import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers';

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

describe('health', () => {
  it('reports liveness and readiness', async () => {
    expect((await app.call('GET', '/healthz')).body).toMatchObject({ ok: true });
    expect((await app.call('GET', '/readyz')).status).toBe(200);
  });

  it('returns JSON errors with a request id', async () => {
    const res = await app.call('GET', '/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('rejects malformed JSON', async () => {
    const res = await app.call('POST', '/v1/auth/dev/login', {
      body: undefined,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(400);
  });
});
