import type { Container } from '@lodgent/application';
import { z } from 'zod';
import { ParamsWithOrg, type Router } from '../http/router';

const ConnectionStatus = z.object({
  connected: z.boolean(),
  provider: z.literal('apaleo'),
  accountCode: z.string().nullable(),
  accountName: z.string().nullable(),
  status: z.enum(['active', 'error', 'revoked']).nullable(),
  lastSyncAt: z.iso.datetime().nullable(),
  lastSyncStatus: z.string().nullable(),
  lastSyncError: z.string().nullable(),
  lastSyncStats: z.record(z.string(), z.number()).nullable(),
  webhooksActive: z.boolean(),
});

export function registerIntegrationRoutes(router: Router, container: Container): void {
  const { pmsConnections, pmsWebhooks } = container.services;
  const base = { tags: ['integrations'], audience: 'dashboard', auth: 'org' } as const;

  router.add({
    ...base,
    method: 'GET',
    path: '/v1/orgs/:orgId/integrations/apaleo',
    operationId: 'getApaleoConnection',
    summary: 'Apaleo connection status',
    permission: 'property.read',
    params: ParamsWithOrg,
    response: ConnectionStatus,
    handler: async ({ org }) => pmsConnections.status(org),
  });

  router.add({
    ...base,
    method: 'POST',
    path: '/v1/orgs/:orgId/integrations/apaleo/authorize',
    operationId: 'startApaleoConnection',
    summary: 'Start connecting Apaleo; returns the Apaleo consent URL to send the browser to',
    permission: 'pms.manage',
    params: ParamsWithOrg,
    response: z.object({ url: z.url() }),
    handler: async ({ org }) => ({ url: pmsConnections.authorizeUrl(org) }),
  });

  router.add({
    method: 'GET',
    path: '/v1/integrations/apaleo/callback',
    operationId: 'apaleoOAuthCallback',
    summary: 'OAuth redirect target registered with Apaleo',
    tags: ['integrations'],
    audience: 'dashboard',
    auth: 'none',
    rateLimitPerMinute: 30,
    query: z.object({
      code: z.string().max(2000).optional(),
      state: z.string().max(2000).optional(),
      error: z.string().max(200).optional(),
    }),
    response: null,
    handler: async ({ query, reply, req }) => {
      const { redirectTo, error } = await pmsConnections.completeAuthorization(query);
      if (error) req.log.warn({ err: error }, 'Apaleo OAuth callback failed');
      await reply.redirect(redirectTo, 303);
    },
  });

  router.add({
    ...base,
    method: 'POST',
    path: '/v1/orgs/:orgId/integrations/apaleo/sync',
    operationId: 'syncApaleo',
    summary: 'Re-import properties, room types and rate plans from Apaleo',
    permission: 'pms.manage',
    rateLimitPerMinute: 6,
    params: ParamsWithOrg,
    response: null,
    status: 202,
    handler: async ({ org }) => pmsConnections.requestSync(org),
  });

  router.add({
    ...base,
    method: 'DELETE',
    path: '/v1/orgs/:orgId/integrations/apaleo',
    operationId: 'disconnectApaleo',
    summary: 'Disconnect Apaleo (revokes our access; agents can no longer book)',
    permission: 'pms.manage',
    params: ParamsWithOrg,
    response: null,
    handler: async ({ org }) => pmsConnections.disconnect(org),
  });

  router.add({
    method: 'POST',
    path: '/webhooks/apaleo/:token',
    operationId: 'apaleoWebhook',
    summary: 'Apaleo webhook receiver',
    tags: ['webhooks'],
    audience: 'webhook',
    auth: 'none',
    rateLimitPerMinute: 1200,
    params: z.object({ token: z.string().max(200) }),
    body: z.unknown(),
    response: z.object({ accepted: z.boolean() }),
    handler: async ({ params, body }) => pmsWebhooks.handleApaleo(params.token, body),
  });
}
