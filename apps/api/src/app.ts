import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Container } from '@lodgent/application';
import { BRAND } from '@lodgent/shared';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerCardDataGuard } from './http/card-guard';
import { registerErrorHandler } from './http/errors';
import { buildOpenApi } from './http/openapi';
import { Router } from './http/router';
import { BODY_LIMITS, corsOptionsFor, requestIdFor, serializeRequest } from './http/security';
import { registerMcpEndpoint } from './mcp/server';
import { registerAccountRoutes } from './routes/account';
import { registerAgentRoutes } from './routes/agent';
import { registerBookingRoutes } from './routes/bookings';
import { registerCheckoutRoutes } from './routes/checkout';
import { registerIntegrationRoutes } from './routes/integrations';
import { registerOrganizationRoutes } from './routes/organizations';
import { registerProfileRoutes } from './routes/profile';
import { registerPropertyRoutes } from './routes/properties';
import { registerVisibilityRoutes } from './routes/visibility';

declare module 'fastify' {
  interface FastifyRequest {
    /** Exact request bytes, for webhook signature verification. */
    rawBody?: Buffer;
  }
  interface FastifyContextConfig {
    rawBody?: boolean;
  }
}

export interface App {
  server: FastifyInstance;
  router: Router;
}

export async function buildApp(container: Container): Promise<App> {
  const { config } = container;
  const server = Fastify({
    // Request URLs are logged with checkout tokens, webhook secrets and OAuth codes masked.
    loggerInstance: container.logger.child(
      {},
      { serializers: { req: serializeRequest } },
    ) as FastifyBaseLogger,
    // Behind the ALB in production: trust exactly one proxy hop for the client IP (rate limits, logs).
    trustProxy: config.isProduction ? (_address: string, hop: number) => hop === 0 : false,
    bodyLimit: BODY_LIMITS.default,
    // Signed checkout tokens travel as a path segment (~120 chars).
    routerOptions: { maxParamLength: 600 },
    requestIdHeader: false,
    genReqId: requestIdFor,
  });

  // JSON bodies keep their exact bytes (webhook signatures, card-data guard) and are parsed with
  // Fastify's hardened parser: invalid JSON is a 400 and `__proto__`/`constructor.prototype` keys are
  // rejected rather than parsed (prototype poisoning).
  const parseJson = server.getDefaultJsonParser('error', 'error');
  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const buffer = body as Buffer;
    req.rawBody = buffer;
    if (buffer.length === 0) return done(null, undefined);
    parseJson(req, buffer.toString('utf8'), done);
  });

  await server.register(helmet, {
    // The API serves JSON only: nothing may load, run or frame it.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] },
    },
    // Agents in browsers may read public agent responses.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    strictTransportSecurity: config.isProduction
      ? { maxAge: 63_072_000, includeSubDomains: true, preload: false }
      : false,
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
  });
  await server.register(cors, {
    delegator: (req, callback) => callback(null, corsOptionsFor(req.url, config.webBaseUrl)),
  });
  await server.register(rateLimit, { global: false });
  registerErrorHandler(server);
  registerCardDataGuard(server);

  server.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    // Responses carry tenant data, guest details or capability links: never store them in caches.
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });

  const router = new Router(server, container);
  registerAccountRoutes(router, container);
  registerOrganizationRoutes(router, container);
  registerPropertyRoutes(router, container);
  registerIntegrationRoutes(router, container);
  registerProfileRoutes(router, container);
  registerAgentRoutes(router, container);
  registerCheckoutRoutes(router, container);
  registerVisibilityRoutes(router, container);
  registerBookingRoutes(router, container);
  registerMcpEndpoint(server, container);

  server.get('/healthz', async () => ({ ok: true, service: `${BRAND.slug}-api` }));
  server.get('/readyz', async (_req, reply) => {
    const ok = await container.db.ping().catch(() => false);
    return reply.status(ok ? 200 : 503).send({ ok });
  });

  const agentSpec = buildOpenApi(router.routes, {
    audiences: ['agent'],
    title: `${BRAND.name} Agent API`,
    description: `Search, quote and hold rooms at independent hotels that sell direct through ${BRAND.name}. The same capabilities are available over MCP at /mcp. Never send payment card data to this API: guests pay on the hosted checkout page returned by create_hold.`,
    serverUrl: config.apiBaseUrl,
  });
  const fullSpec = buildOpenApi(router.routes, {
    audiences: ['agent', 'dashboard', 'checkout', 'webhook'],
    title: `${BRAND.name} API`,
    description: `Complete ${BRAND.name} API: agent surface, hotel dashboard, guest checkout and webhooks.`,
    serverUrl: config.apiBaseUrl,
  });
  server.get('/openapi.json', async () => agentSpec);
  server.get('/openapi.full.json', async () => fullSpec);

  return { server, router };
}
