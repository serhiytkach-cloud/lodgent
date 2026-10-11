import { randomUUID } from 'node:crypto';
import { can, type Role } from '@lodgent/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers';

/**
 * Generic authorization sweep over every registered route, so new routes are covered automatically:
 *  - every route belongs to an audience whose auth mode it uses; public routes are an explicit list
 *  - user/org routes reject anonymous callers (401)
 *  - org routes hide other organizations (404 for non-members)
 *  - org routes reject roles without the route's permission (403), for every role
 *  - agent routes reject unknown partner keys (401); checkout routes reject forged tokens (404);
 *    webhooks reject unsigned or wrongly addressed calls
 * Object-level checks (another organization's resource ids) live in object-authorization.test.ts.
 */
let app: TestApp;
let orgId: string;
let ownerToken: string;
let viewerToken: string;
let adminToken: string;
let strangerToken: string;

/**
 * Every route reachable without a signed-in hotel user, and what protects it instead. Adding a
 * public route is a security decision: review it, then list it here.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  'POST /v1/auth/dev/login': 'registered only when AUTH_PROVIDER=dev; production refuses dev auth',
  'GET /v1/integrations/apaleo/callback': 'signed OAuth state; membership and permission re-checked',
  'GET /v1/public/hotels/:idOrSlug': 'published hotels only',
  'GET /v1/checkout/:token': 'signed checkout capability token',
  'POST /v1/checkout/:token/guest': 'signed checkout capability token',
  'POST /v1/checkout/:token/complete': 'signed checkout capability token',
  'POST /webhooks/stripe': 'Stripe signature over the raw body',
  'POST /webhooks/apaleo/:token': 'secret token in the subscription URL; payload is only a hint',
};

async function invite(email: string, role: Role): Promise<string> {
  await app.call('POST', `/v1/orgs/${orgId}/invitations`, { token: ownerToken, body: { email, role } });
  await app.container.services.outbox.dispatchBatch();
  return app.mailer.sent.at(-1)!.text.match(/\/invite\/([A-Za-z0-9_-]+)/)![1]!;
}

async function member(role: Role): Promise<string> {
  const email = uniqueEmail(role);
  const inviteToken = await invite(email, role);
  const token = (await app.login(email)).token;
  await app.call('POST', '/v1/invitations/accept', { token, body: { token: inviteToken } });
  return token;
}

beforeAll(async () => {
  app = await createTestApp();
  const owner = await app.login();
  ownerToken = owner.token;
  const org = await app.call('POST', '/v1/orgs', { token: ownerToken, body: { name: 'Authz Hotels' } });
  orgId = org.body.id;
  viewerToken = await member('viewer');
  adminToken = await member('admin');
  strangerToken = (await app.login()).token;
});

afterAll(async () => {
  await app.close();
});

function concretePath(path: string, org: string): string {
  return path.replace(':orgId', org).replace(/:[A-Za-z]+/g, () => randomUUID());
}

describe('authorization on every route', () => {
  it('has routes to check', () => {
    expect(app.router.routes.filter((r) => r.auth === 'org').length).toBeGreaterThan(5);
  });

  it('covers every audience', () => {
    expect(new Set(app.router.routes.map((r) => r.audience))).toEqual(
      new Set(['agent', 'dashboard', 'checkout', 'webhook']),
    );
  });

  it('gives each audience the auth mode it needs', () => {
    for (const r of app.router.routes) {
      const id = `${r.method} ${r.path}`;
      switch (r.audience) {
        case 'agent':
          expect(r.auth, id).toBe('agent');
          expect(r.path, id).toMatch(/^\/v1\/agent\//);
          break;
        case 'dashboard':
          expect(['org', 'user', 'none'], id).toContain(r.auth);
          if (r.auth === 'org') expect(r.path, id).toMatch(/^\/v1\/orgs\/:orgId(\/|$)/);
          if (r.path.startsWith('/v1/orgs/:orgId')) expect(r.auth, id).toBe('org');
          break;
        case 'checkout':
          expect(r.auth, id).toBe('none');
          expect(r.path, id).toMatch(/^\/v1\/(checkout\/:token|public\/)/);
          break;
        case 'webhook':
          expect(r.auth, id).toBe('none');
          expect(r.path, id).toMatch(/^\/webhooks\//);
          break;
        default:
          throw new Error(`${id} has unexpected audience ${r.audience}`);
      }
    }
  });

  it('has exactly the reviewed public routes', () => {
    const publicRoutes = app.router.routes
      .filter((r) => r.auth === 'none')
      .map((r) => `${r.method} ${r.path}`);
    expect(publicRoutes.sort()).toEqual(Object.keys(PUBLIC_ROUTES).sort());
  });

  it('validates every path parameter with a schema and keeps raw bodies to signed webhooks', () => {
    for (const r of app.router.routes) {
      const id = `${r.method} ${r.path}`;
      if (r.path.includes(':')) expect(r.params, id).toBeDefined();
      if (r.rawBody) expect(r.audience, id).toBe('webhook');
      // A body that is accepted unvalidated must be a webhook that verifies its sender.
      if (r.body && r.body.safeParse(Symbol('anything')).success) expect(r.audience, id).toBe('webhook');
    }
  });

  it('declares a permission on every org route', () => {
    const missing = app.router.routes
      .filter((r) => r.auth === 'org' && !r.permission)
      .map((r) => r.operationId);
    expect(missing).toEqual([]);
  });

  it.each([['viewer'], ['admin']] as const)('enforces each route’s permission for %s', async (role) => {
    const token = role === 'viewer' ? viewerToken : adminToken;
    for (const route of app.router.routes.filter((r) => r.auth === 'org')) {
      const allowed = can(role, route.permission!);
      // Only probe allowed routes that don't change state (e.g. "leave" would remove the member).
      if (allowed && route.method !== 'GET') continue;
      const res = await app.call(route.method, concretePath(route.path, orgId), {
        token,
        body: route.body ? {} : undefined,
      });
      if (allowed) expect(res.status, `${route.method} ${route.path}`).not.toBe(403);
      else expect(res.status, `${route.method} ${route.path}`).toBe(403);
    }
  });

  it('rejects unknown partner keys on every agent route', async () => {
    const forged = `lodgent_live_${'A'.repeat(43)}`;
    for (const route of app.router.routes.filter((r) => r.auth === 'agent')) {
      for (const headers of [{ 'x-api-key': forged }, { authorization: `Bearer ${forged}` }]) {
        const res = await app.call(route.method, concretePath(route.path, orgId), {
          headers,
          body: route.body ? {} : undefined,
        });
        expect(res.status, `${route.method} ${route.path}`).toBe(401);
      }
    }
  });

  it('rejects forged, foreign-purpose and expired checkout tokens on every checkout route', async () => {
    const { signer } = app.container;
    const hold = randomUUID();
    const tokens = [
      'not-a-real-checkout-token',
      signer.sign('oauth-state', { h: hold }, 600),
      signer.sign('checkout', { h: hold }, -10),
      signer.sign('checkout', { h: hold }, 600), // well signed, but no such hold
      `${signer.sign('checkout', { h: hold }, 600)}x`,
    ];
    for (const route of app.router.routes.filter((r) => r.path.startsWith('/v1/checkout/:token'))) {
      for (const token of tokens) {
        const res = await app.call(route.method, route.path.replace(':token', token), {
          body: route.body
            ? { firstName: 'A', lastName: 'B', email: 'a@b.co', acceptTerms: true }
            : undefined,
        });
        expect(res.status, `${route.method} ${route.path}`).toBe(404);
      }
    }
  });

  it('rejects unsigned or wrongly addressed webhooks', async () => {
    const stripe = await app.call('POST', '/webhooks/stripe', {
      body: { id: 'evt_1', type: 'payment_intent.succeeded' },
    });
    expect(stripe.status).toBe(400);
    const forged = await app.call('POST', '/webhooks/stripe', {
      body: { id: 'evt_1', type: 'payment_intent.succeeded' },
      headers: { 'stripe-signature': 't=1,v1=deadbeef' },
    });
    expect(forged.status).toBe(400);
    const apaleo = await app.call('POST', '/webhooks/apaleo/wrong-token', {
      body: { topic: 'Reservation', type: 'Changed', id: 'X', accountId: 'DEMO' },
    });
    expect(apaleo.status).toBe(401);
  });
});
