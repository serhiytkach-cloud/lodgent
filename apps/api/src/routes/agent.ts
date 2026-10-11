import type { AgentCaller, Container } from '@lodgent/application';
import {
  CreateHoldInput,
  GetHotelResult,
  GetOffersInput,
  GetOffersResult,
  HoldDto,
  SearchHotelsInput,
  SearchHotelsResult,
} from '@lodgent/shared';
import { z } from 'zod';
import type { AgentContext } from '../http/agent-auth';
import type { Router } from '../http/router';

export function toCaller(agent: AgentContext): AgentCaller {
  return {
    partnerId: agent.partner?.id ?? null,
    channel: agent.channel,
    clientName: agent.clientName,
    utm: agent.utm,
  };
}

/** REST twin of the MCP tools (same service, same schemas). */
export function registerAgentRoutes(router: Router, container: Container): void {
  const { agent } = container.services;
  const base = { tags: ['agent'], audience: 'agent', auth: 'agent' } as const;

  router.add({
    ...base,
    method: 'POST',
    path: '/v1/agent/search',
    operationId: 'searchHotels',
    summary: 'Search hotels',
    description:
      'Find published hotels by destination, dates, party, hard requirements and soft preferences. Requirements are plain phrases ("sauna", "dog friendly"); each result explains why it ranks where it does. With dates, results include the cheapest live all-in offer.',
    body: SearchHotelsInput,
    response: SearchHotelsResult,
    handler: async ({ agent: a, body }) => agent.search(toCaller(a), body),
  });

  router.add({
    ...base,
    method: 'GET',
    path: '/v1/agent/hotels/:hotelId',
    operationId: 'getHotel',
    summary: 'Get a hotel profile',
    description: 'Approved facts, rooms, sellable rate plans and policies of a published hotel.',
    params: z.object({ hotelId: z.string().min(1).max(120) }),
    response: GetHotelResult,
    handler: async ({ agent: a, params }) => agent.hotel(toCaller(a), params.hotelId),
  });

  router.add({
    ...base,
    method: 'GET',
    path: '/v1/agent/hotels/:hotelId/offers',
    operationId: 'getOffers',
    summary: 'Get live offers',
    description:
      'Live, all-in prices from the hotel’s PMS for a stay. Each offer has an offerId valid until expiresAt; pass it to createHold.',
    params: z.object({ hotelId: z.uuid() }),
    query: GetOffersInput.omit({ hotelId: true }).extend({
      adults: z.coerce.number().int().min(1).max(10).default(2),
      childrenAges: z
        .union([z.array(z.coerce.number().int().min(0).max(17)), z.string()])
        .optional()
        .transform((v) => (typeof v === 'string' ? v.split(',').filter(Boolean).map(Number) : (v ?? [])))
        .pipe(z.array(z.number().int().min(0).max(17)).max(6))
        .describe('Ages of children, comma-separated, e.g. 4,9'),
    }),
    response: GetOffersResult,
    handler: async ({ agent: a, params, query }) =>
      agent.offers(toCaller(a), { ...query, hotelId: params.hotelId }),
  });

  router.add({
    ...base,
    method: 'POST',
    path: '/v1/agent/holds',
    operationId: 'createHold',
    summary: 'Hold a room',
    description:
      'Holds the room of an offer for a short time and returns a secure checkout URL for the guest. Guests enter their details and pay on that page; never send card data to this API.',
    rateLimitPerMinute: 30,
    body: CreateHoldInput,
    response: HoldDto,
    status: 201,
    handler: async ({ agent: a, body }) => agent.createHold(toCaller(a), body.offerId),
  });

  router.add({
    ...base,
    method: 'GET',
    path: '/v1/agent/holds/:holdId',
    operationId: 'getHoldStatus',
    summary: 'Get hold status',
    description: 'Whether the guest has completed checkout, and the confirmation number once booked.',
    params: z.object({ holdId: z.uuid() }),
    response: HoldDto,
    handler: async ({ agent: a, params }) => agent.holdStatus(toCaller(a), params.holdId),
  });
}
