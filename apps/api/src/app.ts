import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Container } from '@lodgent/application';
import { BRAND } from '@lodgent/shared';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerErrorHandler } from './http/errors';
import { buildOpenApi } from './http/openapi';
import { Router } from './http/router';
import { registerMcpEndpoint } from './mcp/server';
import { registerAccountRoutes } from './routes/account';
import { registerAgentRoutes } from './routes/agent';
import { registerIntegrationRoutes } from './routes/integrations';
import { registerOrganizationRoutes } from './routes/organizations';
import { registerProfileRoutes } from './routes/profile';
import { registerPropertyRoutes } from './routes/properties';

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
    loggerInstance: container.logger as FastifyBaseLogger,
    // Behind the ALB in production: trust exactly one proxy hop for the client IP (rate limits, logs).
    trustProxy: config.isProduction ? (_address: string, hop: number) => hop === 0 : false,
    bodyLimit: 1024 * 1024,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });

  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const buffer = body as Buffer;
    req.rawBody = buffer;
    if (buffer.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(buffer.toString('utf8')));
    } catch {
      const error = Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 });
      done(error, undefined);
    }
  });

  await server.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await server.register(cors, {
    origin: true,
    credentials: false,
    exposedHeaders: ['Mcp-Session-Id', 'X-Request-Id'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Api-Key',
      'Mcp-Session-Id',
      'Mcp-Protocol-Version',
      'X-Request-Id',
    ],
  });
  await server.register(rateLimit, { global: false });
  registerErrorHandler(server);

  server.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  const router = new Router(server, container);
  registerAccountRoutes(router, container);
  registerOrganizationRoutes(router, container);
  registerPropertyRoutes(router, container);
  registerIntegrationRoutes(router, container);
  registerProfileRoutes(router, container);
  registerAgentRoutes(router, container);
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
