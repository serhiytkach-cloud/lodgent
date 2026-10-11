/**
 * One-off migration entrypoint, shipped in the API image:
 *   node apps/api/dist/migrate.js
 * Applies every pending SQL migration and exits 0, or logs the error and exits 1. The deploy
 * pipeline runs it as an ECS task before the services are updated (docs/runbooks/deploy.md).
 */
import { fileURLToPath } from 'node:url';
import { migrationsFolder, runMigrations } from '@lodgent/db';
import { BRAND } from '@lodgent/shared';
import pino from 'pino';
import { migrationTargetFromEnv, resolveMigrationsFolder } from './migration-config';

const logger = pino({ name: `${BRAND.slug}-migrate` });

const candidates = process.env.LODGENT_MIGRATIONS_DIR
  ? [migrationsFolder]
  : [migrationsFolder, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url))];

try {
  const target = migrationTargetFromEnv(process.env);
  const folder = resolveMigrationsFolder(candidates);
  logger.info({ database: target.description, ssl: target.ssl, folder }, 'applying database migrations');
  const started = performance.now();
  await runMigrations(target.connectionString, folder, { ssl: target.ssl });
  logger.info(
    { database: target.description, durationMs: Math.round(performance.now() - started) },
    'database migrations applied',
  );
  process.exit(0);
} catch (error) {
  logger.error({ err: error }, 'database migrations failed');
  process.exit(1);
}
