import type { Container } from '@lodgent/application';
import {
  AuditEntryDto,
  CreateInvitationInput,
  InvitationDto,
  MemberDto,
  OrganizationDto,
  RoleSchema,
  UpdateOrganizationInput,
} from '@lodgent/shared';
import { z } from 'zod';
import { ParamsWithOrg, type Router } from '../http/router';

const MemberParams = ParamsWithOrg.extend({ userId: z.uuid() });
const InvitationParams = ParamsWithOrg.extend({ invitationId: z.uuid() });

export function registerOrganizationRoutes(router: Router, container: Container): void {
  const { organizations, members, audit } = container.services;
  const base = { tags: ['organizations'], audience: 'dashboard', auth: 'org' } as const;

  router.add({
    ...base,
    method: 'GET',
    path: '/v1/orgs/:orgId',
    operationId: 'getOrganization',
    summary: 'Get an organization',
    permission: 'org.read',
    params: ParamsWithOrg,
    response: OrganizationDto,
    handler: async ({ org }) => organizations.get(org),
  });

  router.add({
    ...base,
    method: 'PATCH',
    path: '/v1/orgs/:orgId',
    operationId: 'updateOrganization',
    summary: 'Update an organization',
    permission: 'org.update',
    params: ParamsWithOrg,
    body: UpdateOrganizationInput,
    response: OrganizationDto,
    handler: async ({ org, body }) => organizations.update(org, body),
  });

  router.add({
    ...base,
    method: 'GET',
    path: '/v1/orgs/:orgId/members',
    operationId: 'listMembers',
    summary: 'List members',
    permission: 'members.read',
    params: ParamsWithOrg,
    response: z.object({ members: z.array(MemberDto) }),
    handler: async ({ org }) => ({ members: await members.list(org) }),
  });

  router.add({
    ...base,
    method: 'PATCH',
    path: '/v1/orgs/:orgId/members/:userId',
    operationId: 'changeMemberRole',
    summary: 'Change a member’s role (owners only)',
    permission: 'members.manage',
    params: MemberParams,
    body: z.object({ role: RoleSchema }),
    response: null,
    handler: async ({ org, params, body }) => members.changeRole(org, params.userId, body.role),
  });

  router.add({
    ...base,
    method: 'DELETE',
    path: '/v1/orgs/:orgId/members/:userId',
    operationId: 'removeMember',
    summary: 'Remove a member (owners only)',
    permission: 'members.manage',
    params: MemberParams,
    response: null,
    handler: async ({ org, params }) => members.remove(org, params.userId),
  });

  router.add({
    ...base,
    method: 'POST',
    path: '/v1/orgs/:orgId/leave',
    operationId: 'leaveOrganization',
    summary: 'Leave the organization',
    permission: 'members.read',
    params: ParamsWithOrg,
    response: null,
    handler: async ({ org }) => members.remove(org, org.userId),
  });

  router.add({
    ...base,
    method: 'GET',
    path: '/v1/orgs/:orgId/invitations',
    operationId: 'listInvitations',
    summary: 'List pending invitations',
    permission: 'members.invite',
    params: ParamsWithOrg,
    response: z.object({ invitations: z.array(InvitationDto) }),
    handler: async ({ org }) => ({ invitations: await members.listInvitations(org) }),
  });

  router.add({
    ...base,
    method: 'POST',
    path: '/v1/orgs/:orgId/invitations',
    operationId: 'createInvitation',
    summary: 'Invite someone by email',
    permission: 'members.invite',
    rateLimitPerMinute: 30,
    params: ParamsWithOrg,
    body: CreateInvitationInput,
    response: InvitationDto,
    status: 201,
    handler: async ({ org, body }) => members.invite(org, body),
  });

  router.add({
    ...base,
    method: 'DELETE',
    path: '/v1/orgs/:orgId/invitations/:invitationId',
    operationId: 'revokeInvitation',
    summary: 'Revoke a pending invitation',
    permission: 'members.invite',
    params: InvitationParams,
    response: null,
    handler: async ({ org, params }) => members.revokeInvitation(org, params.invitationId),
  });

  router.add({
    ...base,
    method: 'GET',
    path: '/v1/orgs/:orgId/audit-log',
    operationId: 'listAuditLog',
    summary: 'Audit log of every change made in the organization',
    permission: 'audit.read',
    params: ParamsWithOrg,
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      before: z.iso.datetime().optional(),
    }),
    response: z.object({ entries: z.array(AuditEntryDto) }),
    handler: async ({ org, query }) => ({
      entries: await audit.list(org, {
        limit: query.limit,
        before: query.before ? new Date(query.before) : undefined,
      }),
    }),
  });
}
