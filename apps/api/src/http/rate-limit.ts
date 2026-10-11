import type { Container } from '@lodgent/application';
import type { FastifyRequest } from 'fastify';
import { resolveAgent } from './agent-auth';
import { clientKey } from './security';

/**
 * Rate limits for the agent surface: partners (valid API key) are limited per key, everyone else per
 * client IP with a stricter budget. An invalid key falls back to the IP bucket (and the request then
 * fails authentication), so rotating fake keys never buys extra requests.
 */
export function agentRateLimit(container: Container, override?: number) {
  const partnerOf = async (req: FastifyRequest) => {
    try {
      return (await resolveAgent(req, container)).partner;
    } catch {
      return null;
    }
  };
  return {
    max: async (req: FastifyRequest) =>
      (await partnerOf(req))
        ? (override ?? container.config.rateLimits.partnerPerMinute)
        : Math.min(override ?? Number.POSITIVE_INFINITY, container.config.rateLimits.anonymousPerMinute),
    timeWindow: '1 minute',
    keyGenerator: async (req: FastifyRequest) => {
      const partner = await partnerOf(req);
      return partner ? `partner:${partner.id}` : `ip:${clientKey(req.ip)}`;
    },
  };
}
