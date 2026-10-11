import type { Container } from '@lodgent/application';
import {
  BookingDetailDto,
  BookingListDto,
  BookingListQuery,
  FeesDto,
  FunnelDto,
  FunnelQuery,
} from '@lodgent/shared';
import { z } from 'zod';
import { ParamsWithOrg, type Router } from '../http/router';

const BookingParams = ParamsWithOrg.extend({ bookingId: z.uuid() });
const Period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a month formatted YYYY-MM');

export function registerBookingRoutes(router: Router, container: Container): void {
  const { bookings, billing } = container.services;
  const base = { audience: 'dashboard', auth: 'org' } as const;

  router.add({
    ...base,
    tags: ['bookings'],
    method: 'GET',
    path: '/v1/orgs/:orgId/bookings',
    operationId: 'listBookings',
    summary: 'Agent bookings, newest first, with status, fee and PMS link',
    permission: 'bookings.read',
    params: ParamsWithOrg,
    query: BookingListQuery,
    response: BookingListDto,
    handler: async ({ org, query }) => bookings.list(org, query),
  });

  router.add({
    ...base,
    tags: ['bookings'],
    method: 'GET',
    path: '/v1/orgs/:orgId/bookings/:bookingId',
    operationId: 'getBooking',
    summary: 'One booking with price breakdown, payment, fee and timeline',
    description: 'Guest contact details are included only for roles that manage guest data.',
    permission: 'bookings.read',
    params: BookingParams,
    response: BookingDetailDto,
    handler: async ({ org, params }) => bookings.detail(org, params.bookingId),
  });

  router.add({
    ...base,
    tags: ['bookings'],
    method: 'GET',
    path: '/v1/orgs/:orgId/exports/bookings.csv',
    operationId: 'exportBookingsCsv',
    summary: 'Bookings as CSV (no guest contact details)',
    permission: 'bookings.read',
    rateLimitPerMinute: 10,
    params: ParamsWithOrg,
    query: BookingListQuery.omit({ limit: true, offset: true }),
    response: z.string(),
    produces: 'text/csv',
    handler: async ({ org, query, reply }) => {
      reply.header('content-disposition', 'attachment; filename="bookings.csv"');
      return bookings.exportCsv(org, query);
    },
  });

  router.add({
    ...base,
    tags: ['bookings'],
    method: 'GET',
    path: '/v1/orgs/:orgId/funnel',
    operationId: 'getAgentFunnel',
    summary: 'Agent funnel: searches → views → quotes → holds → checkouts → paid → reservations',
    permission: 'bookings.read',
    params: ParamsWithOrg,
    query: FunnelQuery,
    response: FunnelDto,
    handler: async ({ org, query }) => bookings.funnel(org, query),
  });

  router.add({
    ...base,
    tags: ['billing'],
    method: 'GET',
    path: '/v1/orgs/:orgId/fees',
    operationId: 'getFees',
    summary: 'Fee rates, monthly fee totals and fee invoices',
    permission: 'billing.read',
    params: ParamsWithOrg,
    response: FeesDto,
    handler: async ({ org }) => billing.fees(org),
  });

  router.add({
    ...base,
    tags: ['billing'],
    method: 'GET',
    path: '/v1/orgs/:orgId/exports/fees.csv',
    operationId: 'exportFeesCsv',
    summary: 'Fee ledger lines for bookings confirmed in a month, as CSV',
    permission: 'billing.read',
    rateLimitPerMinute: 10,
    params: ParamsWithOrg,
    query: z.object({ period: Period }),
    response: z.string(),
    produces: 'text/csv',
    handler: async ({ org, query, reply }) => {
      reply.header('content-disposition', `attachment; filename="fees-${query.period}.csv"`);
      return billing.feesCsv(org, query.period);
    },
  });
}
