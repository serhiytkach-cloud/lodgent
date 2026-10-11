import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { AgentCaller, Container } from '@lodgent/application';
import { DomainError } from '@lodgent/core';
import {
  BRAND,
  CreateHoldInput,
  GetHotelInput,
  GetHotelResult,
  GetOffersInput,
  GetOffersResult,
  HoldDto,
  HoldIdInput,
  SearchHotelsInput,
  SearchHotelsResult,
} from '@lodgent/shared';
import { type CallToolResult, createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { resolveAgent } from '../http/agent-auth';
import { agentRateLimit } from '../http/rate-limit';
import { toCaller } from '../routes/agent';

export const MCP_INSTRUCTIONS = `${BRAND.name} connects you to independent hotels that sell direct, with live prices from each hotel's own system.

Typical flow:
1. search_hotels with a destination, dates, party size and requirements in plain words ("sauna", "dog friendly", "free parking"). Each result says why it matches.
2. get_offers for the hotel the traveller likes: every room and rate with all-in totals (taxes and mandatory fees included) and cancellation terms.
3. When the traveller has chosen, create_hold with that offerId. Tell them the price and cancellation terms first.
4. Give the traveller the checkoutUrl. They enter their own details and pay (or guarantee with a card) on a secure page before the hold expires (about 15 minutes).
5. get_hold_status shows when the booking is confirmed.

Rules: never ask for or send payment card details; this server never accepts them. Quote prices exactly as returned (use the "formatted" fields). Don't send guest names or contact details in any tool call.`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

function summarizeSearch(r: SearchHotelsResult): string {
  if (r.results.length === 0) return ['No hotels matched.', ...r.notes].join(' ');
  const lines = r.results.map((h) => {
    const price = h.cheapestOffer
      ? ` — from ${h.cheapestOffer.total.formatted} (${h.cheapestOffer.ratePlan})`
      : '';
    return `${h.rank}. ${h.name}, ${h.location.city ?? ''}${price}. ${h.why.join('; ')}.`;
  });
  return [`${r.results.length} hotel(s):`, ...lines, ...r.notes].join('\n');
}

function summarizeOffers(r: z.infer<typeof GetOffersResult>): string {
  if (r.offers.length === 0) return `${r.hotelName}: ${r.notes.join(' ')}`;
  return [
    `${r.offers.length} offer(s) at ${r.hotelName}:`,
    ...r.offers.map(
      (o) =>
        `- ${o.roomType.name} · ${o.ratePlan.name}: ${o.total.formatted} total, ${
          o.paymentMode === 'prepaid' ? 'paid at booking' : 'paid at the hotel'
        }. ${o.cancellationPolicy.summary} (offerId ${o.offerId})`,
    ),
  ].join('\n');
}

function summarizeHold(h: HoldDto): string {
  return [
    `Hold ${h.holdId}: ${h.status}. ${h.hotel.name}, ${h.roomType} · ${h.ratePlan}, ${h.checkIn} to ${h.checkOut}, ${h.total.formatted}.`,
    h.checkoutUrl ? `Checkout link for the traveller: ${h.checkoutUrl}` : null,
    h.nextStep,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The MCP server: one tool per agent capability, each a thin wrapper around AgentService. Results
 * carry both a readable summary and the structured payload (validated against the output schema).
 */
export function createAgentMcpHandler(container: Container) {
  const { agent } = container.services;
  const { logger } = container;

  async function run<T extends Record<string, unknown>>(
    tool: string,
    fn: () => Promise<T>,
    summarize: (out: T) => string,
  ): Promise<CallToolResult> {
    try {
      const out = await fn();
      return {
        content: [{ type: 'text', text: `${summarize(out)}\n\n${JSON.stringify(out)}` }],
        structuredContent: out,
      };
    } catch (error) {
      if (error instanceof DomainError) {
        return { isError: true, content: [{ type: 'text', text: `${error.code}: ${error.message}` }] };
      }
      logger.error({ err: error, tool }, 'MCP tool failed');
      return {
        isError: true,
        content: [
          { type: 'text', text: 'internal_error: Something went wrong on our side. Try again shortly.' },
        ],
      };
    }
  }

  return createMcpHandler(
    (ctx) => {
      const caller = (ctx.authInfo?.extra?.caller as AgentCaller | undefined) ?? {
        partnerId: null,
        channel: 'mcp',
        clientName: null,
        utm: { source: null, medium: null, campaign: null },
      };
      const server = new McpServer(
        { name: BRAND.slug, version: '1.0.0' },
        { instructions: MCP_INSTRUCTIONS },
      );

      server.registerTool(
        'search_hotels',
        {
          title: 'Search hotels',
          description:
            'Find bookable independent hotels. Give a destination (or near), optional dates and party, hard requirements (mustHave) and soft ones (niceToHave) as plain phrases, and optionally a one-sentence description of the stay. Results are ranked deterministically and each explains why; with dates they include the cheapest live all-in offer.',
          inputSchema: SearchHotelsInput,
          outputSchema: SearchHotelsResult,
          annotations: READ_ONLY,
        },
        async (input) => run('search_hotels', () => agent.search(caller, input), summarizeSearch),
      );

      server.registerTool(
        'get_hotel',
        {
          title: 'Get hotel profile',
          description:
            'Full profile of a hotel: description, confirmed amenities and room features, room types, rates sold here, policies and location.',
          inputSchema: GetHotelInput,
          outputSchema: GetHotelResult,
          annotations: READ_ONLY,
        },
        async ({ hotelId }) =>
          run(
            'get_hotel',
            () => agent.hotel(caller, hotelId),
            (r) => `${r.hotel.name}: ${r.hotel.description ?? ''}`,
          ),
      );

      server.registerTool(
        'get_offers',
        {
          title: 'Get live offers',
          description:
            'Live prices and availability for a stay at one hotel: every room and rate with the all-in total (taxes and mandatory fees included), what is due now vs at the hotel, and cancellation terms. Offers expire; use the offerId with create_hold.',
          inputSchema: GetOffersInput,
          outputSchema: GetOffersResult,
          annotations: READ_ONLY,
        },
        async (input) => run('get_offers', () => agent.offers(caller, input), summarizeOffers),
      );

      server.registerTool(
        'create_hold',
        {
          title: 'Hold a room',
          description:
            'Holds the room and rate of an offer for about 15 minutes and returns a secure checkout URL for the traveller, who enters their own details and pays there. Confirm the price and cancellation terms with the traveller first. Never send card details.',
          inputSchema: CreateHoldInput,
          outputSchema: HoldDto,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
        async ({ offerId }) => run('create_hold', () => agent.createHold(caller, offerId), summarizeHold),
      );

      server.registerTool(
        'get_hold_status',
        {
          title: 'Get hold status',
          description:
            'Whether the traveller completed checkout: active, processing, confirmed (with confirmation number), failed, expired or cancelled.',
          inputSchema: HoldIdInput,
          outputSchema: HoldDto,
          annotations: READ_ONLY,
        },
        async ({ holdId }) => run('get_hold_status', () => agent.holdStatus(caller, holdId), summarizeHold),
      );

      return server;
    },
    { onerror: (error) => logger.warn({ err: error }, 'MCP request rejected') },
  );
}

/**
 * Mounts the MCP endpoint at /mcp (Streamable HTTP, stateless). Requests pass through Fastify's
 * hooks (CORS, security headers, request id, rate limits) and are bridged to the SDK's
 * web-standard handler; the caller's partner key is resolved first and handed over as authInfo.
 */
export function registerMcpEndpoint(server: FastifyInstance, container: Container): void {
  const mcp = createAgentMcpHandler(container);
  server.addHook('onClose', async () => {
    await mcp.close();
  });

  server.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    config: { rateLimit: agentRateLimit(container) },
    handler: async (req, reply) => {
      const caller = toCaller(await resolveAgent(req, container));
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(', '));
      }
      const request = new Request(new URL(req.url, `http://${req.headers.host ?? 'localhost'}`), {
        method: req.method,
        headers,
        body: req.method === 'POST' && req.rawBody ? new Uint8Array(req.rawBody) : undefined,
      });
      const response = await mcp.fetch(request, {
        authInfo: {
          token: 'agent',
          clientId: caller.partnerId ?? 'anonymous',
          scopes: [],
          extra: { caller },
        },
        parsedBody: req.method === 'POST' ? req.body : undefined,
      });

      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key !== 'content-length' && key !== 'transfer-encoding') reply.header(key, value);
      });
      if (!response.body) return reply.send();
      if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        return reply.send(Readable.fromWeb(response.body as unknown as NodeReadableStream));
      }
      return reply.send(Buffer.from(await response.arrayBuffer()));
    },
  });
}
