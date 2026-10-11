import { randomUUID } from 'node:crypto';
import { can } from '@lodgent/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers';

/**
 * Generic authorization sweep over every registered route, so new routes are covered automatically:
 *  - user/org routes reject anonymous callers (401)
 *  - org routes hide other organizations (404 for non-members)
 *  - org routes reject roles without the route's permission (403)
 */
let app: TestApp;
let orgId: string;
let ownerToken: string;
let viewerToken: string;
let strangerToken: string;

beforeAll(async () => {
  app = await createTestApp();
  const owner = await app.login();
  ownerToken = owner.token;
  const org = await app.call('POST', '/v1/orgs', { token: ownerToken, body: { name: 'Authz Hotels' } });
  orgId = org.body.id;

  const viewerEmail = uniqueEmail('viewer');
  await app.call('POST', `/v1/orgs/${orgId}/invitations`, {
    token: ownerToken,
    body: { email: viewerEmail, role: 'viewer' },
  });
  await app.container.services.outbox.dispatchBatch();
  const inviteToken = app.mailer.sent.at(-1)!.text.match(/\/invite\/([A-Za-z0-9_-]+)/)![1]!;
  viewerToken = (await app.login(viewerEmail)).token;
  await app.call('POST', '/v1/invitations/accept', { token: viewerToken, body: { token: inviteToken } });
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

  it('rejects anonymous callers on user and org routes', async () => {
    for (const route of app.router.routes.filter((r) => r.auth === 'user' || r.auth === 'org')) {
      const res = await app.call(route.method, concretePath(route.path, orgId), {
        body: route.body ? {} : undefined,
      });
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
    }
  });

  it('hides organizations from non-members', async () => {
    for (const route of app.router.routes.filter((r) => r.auth === 'org')) {
      const res = await app.call(route.method, concretePath(route.path, orgId), {
        token: strangerToken,
        body: route.body ? {} : undefined,
      });
      expect(res.status, `${route.method} ${route.path}`).toBe(404);
    }
  });

  it('declares a permission on every org route', () => {
    const missing = app.router.routes
      .filter((r) => r.auth === 'org' && !r.permission)
      .map((r) => r.operationId);
    expect(missing).toEqual([]);
  });

  it('enforces each route’s permission for viewers', async () => {
    for (const route of app.router.routes.filter((r) => r.auth === 'org')) {
      const allowed = can('viewer', route.permission!);
      // Only probe allowed routes that don't change state (e.g. "leave" would remove the viewer).
      if (allowed && route.method !== 'GET') continue;
      const res = await app.call(route.method, concretePath(route.path, orgId), {
        token: viewerToken,
        body: route.body ? {} : undefined,
      });
      if (allowed) expect(res.status, `${route.method} ${route.path}`).not.toBe(403);
      else expect(res.status, `${route.method} ${route.path}`).toBe(403);
    }
  });
});
