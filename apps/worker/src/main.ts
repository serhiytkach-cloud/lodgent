import { BRAND } from '@lodgent/shared';
import pino from 'pino';

const logger = pino({ name: `${BRAND.slug}-worker`, level: process.env.LOG_LEVEL ?? 'info' });
logger.info('worker started');

const keepAlive = setInterval(() => {}, 60_000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(keepAlive);
    logger.info({ signal }, 'worker stopping');
  });
}
