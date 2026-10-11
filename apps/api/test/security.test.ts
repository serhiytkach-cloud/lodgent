import { UpstreamError } from '@lodgent/core';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientKey, corsOptionsFor, redactUrl, requestIdFor } from '../src/http/security';
import { createTestApp, newOrg, type TestApp } from './helpers';

const WEB = 'https://app.hotel-direct.test';

let app: TestApp;
let production: TestApp;
const logLines: string[] = [];

beforeAll(async () => {
  app = await createTestApp({ WEB_BASE_URL: WEB });
  // Production behaviour (HSTS, proxy trust) without production secrets.
  production = await createTestApp(
    { WEB_BASE_URL: WEB, LOG_LEVEL: 'info' },
    { logger: pino({ level: 'info' }, { write: (line: string) => void logLines.push(line) }) },
    (config) => ({ ...config, isProduction: true }),
  );
});

afterAll(async () => {
  await app.close();
  await production.close();
});

describe('security headers', () => {
  it('locks JSON responses down', async () => {
    const res = await app.call('GET', '/healthz');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none';frame-ancestors 'none';base-uri 'none'",
    );
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('sends HSTS in production', async () => {
    const res = await production.call('GET', '/healthz');
    expect(res.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
  });
});

describe('CORS', () => {
  const preflight = (target: TestApp, url: string, method = 'POST') =>
    target.call('OPTIONS', url, {
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': method,
        'access-control-request-headers': 'content-type,authorization',
      },
    });

  it('lets browser-based agents call the public agent surface without credentials', async () => {
    for (const url of ['/v1/agent/search', '/mcp', '/openapi.json', '/v1/public/hotels/x']) {
      const res = await preflight(app, url);
      expect(res.status, url).toBe(204);
      expect(res.headers['access-control-allow-origin'], url).toBe('*');
      expect(res.headers['access-control-allow-credentials'], url).toBeUndefined();
    }
  });

  it('only names the web app origin on dashboard and checkout routes', async () => {
    for (const url of ['/v1/me', '/v1/orgs/00000000-0000-4000-8000-000000000000', '/v1/checkout/abc']) {
      const res = await preflight(app, url, 'PATCH');
      expect(res.headers['access-control-allow-origin'], url).toBe(WEB);
    }
    const simple = await app.call('GET', '/v1/me', { headers: { origin: 'https://evil.example' } });
    expect(simple.headers['access-control-allow-origin']).toBe(WEB);
  });

  it('never answers CORS for webhooks', async () => {
    const res = await preflight(app, '/webhooks/stripe');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(corsOptionsFor('/webhooks/apaleo/x', WEB)).toEqual({ origin: false });
  });
});

describe('input handling', () => {
  it('rejects malformed JSON, prototype poisoning and other media types with 4xx', async () => {
    const raw = (payload: string, contentType = 'application/json') =>
      app.server.inject({
        method: 'POST',
        url: '/v1/auth/dev/login',
        headers: { 'content-type': contentType },
        payload,
      });
    const bad = await raw('{"email": ');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_request');
    const proto = await raw('{"email":"a@b.co","__proto__":{"isAdmin":true}}');
    expect(proto.statusCode).toBe(400);
    const ctor = await raw('{"email":"a@b.co","constructor":{"prototype":{"isAdmin":true}}}');
    expect(ctor.statusCode).toBe(400);
    const text = await raw('email=a@b.co', 'application/x-www-form-urlencoded');
    expect(text.statusCode).toBe(415);
    expect(text.json().error.code).toBe('unsupported_media_type');
  });

  it('caps request bodies per surface', async () => {
    const pad = (bytes: number) => 'x'.repeat(bytes);
    const agent = await app.call('POST', '/v1/agent/search', {
      body: { destination: 'Lisbon', preferences: pad(70 * 1024) },
    });
    expect(agent.status).toBe(413);
    expect(agent.body.error.code).toBe('payload_too_large');
    const checkout = await app.call('POST', '/v1/checkout/abcdefghijklmnop/guest', {
      body: { firstName: pad(20 * 1024) },
    });
    expect(checkout.status).toBe(413);
    const mcp = await app.call('POST', '/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: pad(70 * 1024) } },
      headers: { accept: 'application/json, text/event-stream' },
    });
    expect(mcp.status).toBe(413);
    const { token } = await app.login();
    const dashboard = await app.call('POST', '/v1/orgs', { token, body: { name: pad(300 * 1024) } });
    expect(dashboard.status).toBe(413);
  });
});

describe('error responses', () => {
  it('never leak internals of unexpected errors', async () => {
    const { token, orgId } = await newOrg(app);
    const { organizations } = app.container.services;
    const original = organizations.get;
    try {
      organizations.get = async () => {
        throw Object.assign(new Error('connect ECONNREFUSED password=hunter2 at Pool.connect'), {
          statusCode: 400, // a library error that happens to carry a 4xx status
        });
      };
      const res = await app.call('GET', `/v1/orgs/${orgId}`, { token });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: {
          code: 'internal_error',
          message: 'Something went wrong',
          details: { requestId: expect.any(String) },
        },
      });
      expect(JSON.stringify(res.body)).not.toMatch(/hunter2|ECONNREFUSED|Pool\.connect|at /);
    } finally {
      organizations.get = original;
    }
  });

  it('return upstream failures without the upstream response body', async () => {
    const { token, orgId } = await newOrg(app);
    const { organizations } = app.container.services;
    const original = organizations.get;
    try {
      organizations.get = async () => {
        throw new UpstreamError('apaleo', 'Apaleo returned 422', {
          status: 422,
          body: '{"guest":{"email":"jane.doe@example.com"}}',
        });
      };
      const res = await app.call('GET', `/v1/orgs/${orgId}`, { token });
      expect(res.status).toBe(502);
      expect(res.body.error.details).toEqual({ service: 'apaleo', status: 422 });
      expect(JSON.stringify(res.body)).not.toContain('jane.doe');
    } finally {
      organizations.get = original;
    }
  });
});

describe('request ids', () => {
  it('keeps well-formed caller ids and replaces anything else', async () => {
    const good = await app.call('GET', '/healthz', { headers: { 'x-request-id': 'trace-1234abcd' } });
    expect(good.headers['x-request-id']).toBe('trace-1234abcd');
    for (const bad of ['short', 'has spaces in it ok', 'x'.repeat(300), '<script>alert(1)</script>']) {
      const res = await app.call('GET', '/healthz', { headers: { 'x-request-id': bad } });
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(requestIdFor({ headers: {} } as never)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('log redaction', () => {
  it('masks capability tokens, webhook secrets and OAuth codes in request logs', async () => {
    await production.call('GET', '/v1/checkout/SECRETCHECKOUTTOKEN1234567890');
    await production.call('POST', '/webhooks/apaleo/SECRETWEBHOOKTOKEN', { body: { topic: 'System' } });
    await production.call('GET', '/v1/integrations/apaleo/callback?code=SECRETOAUTHCODE&state=SECRETSTATE');
    const logs = logLines.join('\n');
    expect(logs).toContain('/v1/checkout/[redacted]');
    expect(logs).toContain('/webhooks/apaleo/[redacted]');
    expect(logs).toContain('code=[redacted]');
    expect(logs).not.toMatch(/SECRETCHECKOUTTOKEN|SECRETWEBHOOKTOKEN|SECRETOAUTHCODE|SECRETSTATE/);
  });

  it.each([
    ['/v1/checkout/abc.def/guest', '/v1/checkout/[redacted]/guest'],
    ['/webhooks/apaleo/tok?x=1', '/webhooks/apaleo/[redacted]?x=1'],
    ['/cb?code=1&state=2&keep=3', '/cb?code=[redacted]&state=[redacted]&keep=3'],
    ['/v1/agent/search?api_key=k&utm_source=a', '/v1/agent/search?api_key=[redacted]&utm_source=a'],
    ['/v1/orgs/1/bookings', '/v1/orgs/1/bookings'],
  ])('redactUrl(%s)', (input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });
});

describe('rate limits', () => {
  it('groups IPv6 clients by /64 and IPv4-mapped clients by their IPv4 address', () => {
    expect(clientKey('2001:db8:1:2:aaaa::1')).toBe(clientKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
    expect(clientKey('2001:db8:1:2::1')).not.toBe(clientKey('2001:db8:1:3::1'));
    expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
  });

  it('limits sign-in attempts per client network', async () => {
    const attempt = (remoteAddress: string) =>
      app.call('POST', '/v1/auth/dev/login', { body: { email: 'limit@example.com' }, remoteAddress });
    for (let i = 0; i < 30; i++) {
      expect((await attempt(`2001:db8:aa:bb::${(i + 1).toString(16)}`)).status).toBe(200);
    }
    // Rotating addresses inside the same /64 buys nothing.
    const blocked = await attempt('2001:db8:aa:bb::ffff');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect((await attempt('2001:db8:aa:cc::1')).status).toBe(200);
  });

  it('refuses malformed partner keys without treating them as anonymous', async () => {
    for (const key of ['lodgent_live_x', `lodgent_live_${'a'.repeat(5000)}`]) {
      const rest = await app.call('POST', '/v1/agent/search', {
        body: { destination: 'Lisbon' },
        headers: { 'x-api-key': key },
      });
      expect(rest.status).toBe(401);
    }
    const mcp = await app.call('POST', '/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      headers: { accept: 'application/json, text/event-stream', 'x-api-key': 'lodgent_live_forged' },
    });
    expect(mcp.status).toBe(401);
  });
});
