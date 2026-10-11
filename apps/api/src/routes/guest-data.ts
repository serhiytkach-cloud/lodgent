import type { Container } from '@lodgent/application';
import {
  GuestDataEraseDto,
  GuestDataEraseInput,
  GuestDataExportDto,
  GuestDataExportInput,
} from '@lodgent/shared';
import { ParamsWithOrg, type Router } from '../http/router';

/**
 * Guest privacy requests (ADR 0015): export and erase everything held about one guest in this
 * organization. The email travels in the POST body so it never appears in URLs or request logs.
 */
export function registerGuestDataRoutes(router: Router, container: Container): void {
  const { privacy } = container.services;
  const base = {
    audience: 'dashboard',
    auth: 'org',
    permission: 'guest-data.manage',
    tags: ['guest data'],
    method: 'POST',
    params: ParamsWithOrg,
    // Per caller IP; the service also caps requests per organization per hour.
    rateLimitPerMinute: 10,
  } as const;

  router.add({
    ...base,
    path: '/v1/orgs/:orgId/guest-data/export',
    operationId: 'exportGuestData',
    summary: 'Export everything held about a guest (by email) in this organization',
    description:
      "Data subject access request: returns the guest's bookings in this organization with stay, property, amounts, status, contact details and timestamps. Matching is case-insensitive. Erased bookings no longer match. The request is audit-logged with a pseudonymous guest reference, never the email.",
    body: GuestDataExportInput,
    response: GuestDataExportDto,
    handler: async ({ org, body, reply }) => {
      reply.header('cache-control', 'no-store');
      return privacy.export(org, body);
    },
  });

  router.add({
    ...base,
    path: '/v1/orgs/:orgId/guest-data/erase',
    operationId: 'eraseGuestData',
    summary: "Erase a guest's personal data (by email) in this organization",
    description:
      "Right to erasure: empties the guest's name, email, phone and requests on all their bookings in this organization and drops unsent confirmation emails. Amounts, dates and references stay for accounting. Idempotent. Bookings still in checkout are deferred. The reservation in the PMS and payment records in the hotel's Stripe account are not changed; the response warns about them.",
    body: GuestDataEraseInput,
    response: GuestDataEraseDto,
    handler: async ({ org, body, reply }) => {
      reply.header('cache-control', 'no-store');
      return privacy.erase(org, body);
    },
  });
}
