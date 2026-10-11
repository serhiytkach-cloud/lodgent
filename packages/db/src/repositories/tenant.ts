import type { Tx } from '../client';
import { offerQuoteRepo, pmsConnectionRepo, policyRepo, ratePlanRepo, roomTypeRepo } from './pms';
import { attributeAssignmentRepo, crawlRepo, descriptionSuggestionRepo, embeddingRepo } from './profile';
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
    pmsConnection: pmsConnectionRepo(tx, orgId),
    roomTypes: roomTypeRepo(tx, orgId),
    ratePlans: ratePlanRepo(tx, orgId),
    policies: policyRepo(tx, orgId),
    offerQuotes: offerQuoteRepo(tx, orgId),
    attributes: attributeAssignmentRepo(tx, orgId),
    descriptions: descriptionSuggestionRepo(tx, orgId),
    embeddings: embeddingRepo(tx, orgId),
    crawls: crawlRepo(tx, orgId),
  };
}

export type TenantRepos = ReturnType<typeof tenantRepos>;
