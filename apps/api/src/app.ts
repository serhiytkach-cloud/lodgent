import { BRAND } from '@lodgent/shared';
import Fastify, { type FastifyInstance } from 'fastify';

export interface BuildAppOptions {
  logLevel?: string;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: options.logLevel ?? 'info' },
  });

  app.get('/healthz', async () => ({ ok: true, service: `${BRAND.slug}-api` }));

  return app;
}
