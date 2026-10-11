import type { Tx } from '../client';
import {
  auditRepo,
  invitationRepo,
  membershipRepo,
  organizationRepo,
  outboxRepo,
  propertyRepo,
} from './tenancy';

/** Repositories bound to one organization. Every query filters by `orgId`; RLS enforces it again. */
export function tenantRepos(tx: Tx, orgId: string) {
  return {
    orgId,
    tx,
    organization: organizationRepo(tx, orgId),
    members: membershipRepo(tx, orgId),
    invitations: invitationRepo(tx, orgId),
    properties: propertyRepo(tx, orgId),
    audit: auditRepo(tx, orgId),
    outbox: outboxRepo(tx, orgId),
  };
}

export type TenantRepos = ReturnType<typeof tenantRepos>;
