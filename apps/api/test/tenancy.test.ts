import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers';

let app: TestApp;

beforeAll(async () => {
  app = await createTestApp();
});

afterAll(async () => {
  await app.close();
});

async function createOrg(token: string, name = 'Boutique Group') {
  const res = await app.call('POST', '/v1/orgs', { token, body: { name } });
  expect(res.status).toBe(201);
  return res.body as { id: string; slug: string; role: string };
}

/** Delivers queued emails and returns the invitation token from the most recent one. */
async function deliverInvitationToken(): Promise<string> {
  await app.container.services.outbox.dispatchBatch();
  const email = app.mailer.sent.at(-1);
  const match = email?.text.match(/\/invite\/([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error('no invitation email');
  return match[1];
}

describe('sign-in and organizations', () => {
  it('rejects anonymous and garbage tokens', async () => {
    expect((await app.call('GET', '/v1/me')).status).toBe(401);
    expect((await app.call('GET', '/v1/me', { token: 'not-a-token' })).status).toBe(401);
  });

  it('creates the user on first sign-in and an org with the caller as owner', async () => {
    const { token, email } = await app.login();
    const me = await app.call('GET', '/v1/me', { token });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.memberships).toEqual([]);

    const org = await createOrg(token, 'Hôtel Collection');
    expect(org.role).toBe('owner');
    expect(org.slug).toMatch(/^hotel-collection/);

    const me2 = await app.call('GET', '/v1/me', { token });
    expect(me2.body.memberships).toEqual([
      expect.objectContaining({ organizationId: org.id, role: 'owner' }),
    ]);
  });

  it('hides organizations from non-members with a 404', async () => {
    const owner = await app.login();
    const stranger = await app.login();
    const org = await createOrg(owner.token);
    const res = await app.call('GET', `/v1/orgs/${org.id}`, { token: stranger.token });
    expect(res.status).toBe(404);
    const props = await app.call('GET', `/v1/orgs/${org.id}/properties`, { token: stranger.token });
    expect(props.status).toBe(404);
  });
});

describe('invitations and roles', () => {
  it('invites a viewer who can read but not write', async () => {
    const owner = await app.login();
    const org = await createOrg(owner.token);
    const property = await app.call('POST', `/v1/orgs/${org.id}/properties`, {
      token: owner.token,
      body: { name: 'Casa Azul', city: 'Lisbon' },
    });
    expect(property.status).toBe(201);

    const viewerEmail = uniqueEmail('viewer');
    const invite = await app.call('POST', `/v1/orgs/${org.id}/invitations`, {
      token: owner.token,
      body: { email: viewerEmail.toUpperCase(), role: 'viewer' },
    });
    expect(invite.status).toBe(201);
    expect(invite.body.email).toBe(viewerEmail);
    expect(JSON.stringify(invite.body)).not.toMatch(/token/i);

    const token = await deliverInvitationToken();
    expect(app.mailer.sent.at(-1)?.to).toBe(viewerEmail);

    const viewer = await app.login(viewerEmail);
    const accept = await app.call('POST', '/v1/invitations/accept', { token: viewer.token, body: { token } });
    expect(accept.status).toBe(200);
    expect(accept.body).toEqual({ organizationId: org.id, role: 'viewer' });

    // reuse is rejected
    const again = await app.call('POST', '/v1/invitations/accept', { token: viewer.token, body: { token } });
    expect(again.status).toBe(422);

    const read = await app.call('GET', `/v1/orgs/${org.id}/properties/${property.body.id}`, {
      token: viewer.token,
    });
    expect(read.status).toBe(200);
    const write = await app.call('PATCH', `/v1/orgs/${org.id}/properties/${property.body.id}`, {
      token: viewer.token,
      body: { name: 'Hijacked' },
    });
    expect(write.status).toBe(403);
  });

  it('only accepts an invitation for the address it was sent to', async () => {
    const owner = await app.login();
    const org = await createOrg(owner.token);
    await app.call('POST', `/v1/orgs/${org.id}/invitations`, {
      token: owner.token,
      body: { email: uniqueEmail('intended'), role: 'admin' },
    });
    const token = await deliverInvitationToken();
    const someoneElse = await app.login();
    const res = await app.call('POST', '/v1/invitations/accept', {
      token: someoneElse.token,
      body: { token },
    });
    expect(res.status).toBe(403);
  });

  it('does not let admins invite owners or manage roles', async () => {
    const owner = await app.login();
    const org = await createOrg(owner.token);
    const adminEmail = uniqueEmail('admin');
    await app.call('POST', `/v1/orgs/${org.id}/invitations`, {
      token: owner.token,
      body: { email: adminEmail, role: 'admin' },
    });
    const admin = await app.login(adminEmail);
    await app.call('POST', '/v1/invitations/accept', {
      token: admin.token,
      body: { token: await deliverInvitationToken() },
    });

    const ownerInvite = await app.call('POST', `/v1/orgs/${org.id}/invitations`, {
      token: admin.token,
      body: { email: uniqueEmail(), role: 'owner' },
    });
    expect(ownerInvite.status).toBe(403);

    const me = await app.call('GET', '/v1/me', { token: owner.token });
    const ownerId = me.body.user.id;
    const demote = await app.call('PATCH', `/v1/orgs/${org.id}/members/${ownerId}`, {
      token: admin.token,
      body: { role: 'viewer' },
    });
    expect(demote.status).toBe(403);
  });

  it('protects the last owner', async () => {
    const owner = await app.login();
    const org = await createOrg(owner.token);
    const me = await app.call('GET', '/v1/me', { token: owner.token });
    const res = await app.call('DELETE', `/v1/orgs/${org.id}/members/${me.body.user.id}`, {
      token: owner.token,
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('last_owner');
    const leave = await app.call('POST', `/v1/orgs/${org.id}/leave`, { token: owner.token });
    expect(leave.status).toBe(422);
  });
});

describe('properties and audit log', () => {
  it('records every change', async () => {
    const owner = await app.login();
    const org = await createOrg(owner.token);
    const created = await app.call('POST', `/v1/orgs/${org.id}/properties`, {
      token: owner.token,
      body: { name: 'Villa Serena', city: 'Sorrento', timeZone: 'Europe/Rome', currency: 'EUR' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'draft', feeBps: 200, timeZone: 'Europe/Rome' });

    const updated = await app.call('PATCH', `/v1/orgs/${org.id}/properties/${created.body.id}`, {
      token: owner.token,
      body: { checkInTime: '15:00', websiteUrl: 'https://villaserena.example' },
    });
    expect(updated.status).toBe(200);

    const invalid = await app.call('PATCH', `/v1/orgs/${org.id}/properties/${created.body.id}`, {
      token: owner.token,
      body: { checkInTime: '25:00' },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.details.issues[0].path).toBe('body.checkInTime');

    const log = await app.call('GET', `/v1/orgs/${org.id}/audit-log`, { token: owner.token });
    expect(log.status).toBe(200);
    const actions = log.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(['property.updated', 'property.created', 'organization.created']);
    expect(log.body.entries[0].changes.checkInTime).toEqual({ from: null, to: '15:00' });
  });
});

describe('OpenAPI', () => {
  it('serves OpenAPI 3.1 documents generated from the route schemas', async () => {
    const full = await app.call('GET', '/openapi.full.json');
    expect(full.status).toBe(200);
    expect(full.body.openapi).toBe('3.1.0');
    expect(full.body.paths['/v1/orgs/{orgId}/properties'].post.requestBody).toBeDefined();
    const agent = await app.call('GET', '/openapi.json');
    expect(agent.body.paths['/v1/orgs/{orgId}']).toBeUndefined();
  });
});
