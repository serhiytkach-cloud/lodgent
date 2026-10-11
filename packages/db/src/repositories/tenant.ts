import type { Tx } from '../client';
import { billingRepo } from './billing';
import { bookingRepo, feeLedgerRepo, holdRepo, paymentAccountRepo } from './bookings';
import { funnelRepo } from './funnel';
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
import { visibilityRepo } from './visibility';

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
    holds: holdRepo(tx, orgId),
    bookings: bookingRepo(tx, orgId),
    fees: feeLedgerRepo(tx, orgId),
    paymentAccount: paymentAccountRepo(tx, orgId),
    visibility: visibilityRepo(tx, orgId),
    billing: billingRepo(tx, orgId),
    funnel: funnelRepo(tx, orgId),
  };
}

export type TenantRepos = ReturnType<typeof tenantRepos>;
