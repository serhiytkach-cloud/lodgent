import type { Container } from '@lodgent/application';
import { NotFoundError } from '@lodgent/core';
import {
  AcceptInvitationInput,
  CreateOrganizationInput,
  MeResponse,
  OrganizationDto,
  RoleSchema,
} from '@lodgent/shared';
import { z } from 'zod';
import type { Router } from '../http/router';

export function registerAccountRoutes(router: Router, container: Container): void {
  if (container.config.auth.provider === 'dev') {
    router.add({
      method: 'POST',
      path: '/v1/auth/dev/login',
      operationId: 'devLogin',
      summary: 'Sign in locally with just an email address (development only)',
      tags: ['auth'],
      audience: 'dashboard',
      auth: 'none',
      rateLimitPerMinute: 30,
      body: z.object({ email: z.email(), name: z.string().trim().min(1).max(120).optional() }),
      response: z.object({ token: z.string() }),
      handler: async ({ body }) => ({ token: await container.devIdentity.issue(body.email, body.name) }),
    });
  }

  router.add({
    method: 'GET',
    path: '/v1/me',
    operationId: 'getMe',
    summary: 'The signed-in user and their organizations',
    tags: ['account'],
    audience: 'dashboard',
    auth: 'user',
    response: MeResponse,
    handler: async ({ user }) => {
      const me = await container.services.accounts.me(user.userId);
      if (!me.user) throw new NotFoundError('User');
      return {
        user: { id: me.user.id, email: me.user.email, name: me.user.name },
        memberships: me.memberships,
      };
    },
  });

  router.add({
    method: 'POST',
    path: '/v1/orgs',
    operationId: 'createOrganization',
    summary: 'Create an organization (hotel group); the caller becomes its owner',
    tags: ['organizations'],
    audience: 'dashboard',
    auth: 'user',
    rateLimitPerMinute: 10,
    body: CreateOrganizationInput,
    response: OrganizationDto,
    status: 201,
    handler: async ({ user, body }) => container.services.organizations.create(user, body),
  });

  router.add({
    method: 'POST',
    path: '/v1/invitations/accept',
    operationId: 'acceptInvitation',
    summary: 'Accept an invitation sent to the signed-in user’s email address',
    tags: ['organizations'],
    audience: 'dashboard',
    auth: 'user',
    rateLimitPerMinute: 20,
    body: AcceptInvitationInput,
    response: z.object({ organizationId: z.uuid(), role: RoleSchema }),
    handler: async ({ user, body }) => container.services.members.acceptInvitation(user, body.token),
  });
}
