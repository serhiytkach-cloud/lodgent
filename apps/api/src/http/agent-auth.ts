import type { Container } from '@lodgent/application';
import { UnauthorizedError } from '@lodgent/core';
import { BRAND } from '@lodgent/shared';
import type { FastifyRequest } from 'fastify';

/** Who is calling the agent surface. Never contains guest PII. */
export interface AgentContext {
  /** The partner behind a valid API key; null for anonymous callers. */
  partner: { id: string; name: string } | null;
  channel: 'rest' | 'mcp';
  clientName: string | null;
  clientVersion: string | null;
  utm: { source: string | null; medium: string | null; campaign: string | null };
}

const cache = new WeakMap<FastifyRequest, Promise<AgentContext>>();

export function apiKeyFrom(req: FastifyRequest): string | null {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    if (token.startsWith(`${BRAND.apiKeyPrefix}_`)) return token;
  }
  return null;
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value.slice(0, 120);
  if (Array.isArray(value)) return firstString(value[0]);
  return null;
}

/**
 * Resolves (once per request) the agent calling the API. An invalid API key is an error rather than
 * silently anonymous, so partners notice misconfiguration.
 */
export function resolveAgent(req: FastifyRequest, container: Container): Promise<AgentContext> {
  const existing = cache.get(req);
  if (existing) return existing;
  const promise = (async (): Promise<AgentContext> => {
    const key = apiKeyFrom(req);
    let partner: AgentContext['partner'] = null;
    if (key) {
      const client = await container.services.agentClients.verify(key);
      if (!client) throw new UnauthorizedError('Invalid or revoked API key');
      partner = { id: client.id, name: client.name };
    }
    const query = (req.query ?? {}) as Record<string, unknown>;
    return {
      partner,
      channel: req.url.startsWith('/mcp') ? 'mcp' : 'rest',
      clientName: firstString(req.headers['x-agent-name']) ?? userAgentProduct(req.headers['user-agent']),
      clientVersion: firstString(req.headers['x-agent-version']),
      utm: {
        source: firstString(query.utm_source),
        medium: firstString(query.utm_medium),
        campaign: firstString(query.utm_campaign),
      },
    };
  })();
  cache.set(req, promise);
  return promise;
}

function userAgentProduct(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  return userAgent.split(/[\s/]/)[0]?.slice(0, 60) || null;
}
