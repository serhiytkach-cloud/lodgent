import { existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Database settings for the migration entrypoint (`node apps/api/dist/migrate.js`).
 *
 * Deliberately narrower than `loadConfig()`: migrations need only the database, so they can run
 * before the app secret (Stripe, Apaleo, ...) is filled in. The variables and their meaning are
 * the same as the app's: either DATABASE_HOST/PORT/NAME/USER/PASSWORD (ECS, from the RDS secret)
 * or DATABASE_URL, plus DATABASE_SSL.
 */

const LOCAL_DATABASE_URL = 'postgres://lodgent:lodgent@localhost:5432/lodgent';
const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(blank, z.string().optional());

const MigrationEnvSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: optionalString,
  // Host names and IP addresses only, so a value cannot smuggle in credentials, a port or a path.
  DATABASE_HOST: z.preprocess(
    blank,
    z
      .string()
      .refine(
        (host) => HOST_NAME.test(host) || isIP(host.replace(/^\[(.*)\]$/, '$1')) !== 0,
        'must be a host name or IP address',
      )
      .optional(),
  ),
  DATABASE_PORT: z.preprocess(blank, z.coerce.number().int().min(1).max(65_535).default(5432)),
  DATABASE_NAME: optionalString,
  DATABASE_USER: optionalString,
  DATABASE_PASSWORD: optionalString,
  DATABASE_SSL: z.preprocess(blank, z.stringbool().default(false)),
});

export interface MigrationTarget {
  connectionString: string;
  ssl: boolean;
  /** `host:port/database`, safe to log (no credentials). */
  description: string;
}

export class MigrationConfigError extends Error {}

export function migrationTargetFromEnv(env: Record<string, string | undefined>): MigrationTarget {
  const parsed = MigrationEnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new MigrationConfigError(`Invalid database configuration: ${issues}`);
  }
  const e = parsed.data;

  if (e.DATABASE_HOST) {
    const missing = (['DATABASE_NAME', 'DATABASE_USER', 'DATABASE_PASSWORD'] as const).filter((k) => !e[k]);
    if (missing.length > 0)
      throw new MigrationConfigError(`DATABASE_HOST is set, so ${missing.join(', ')} must be set too`);
    const bare = e.DATABASE_HOST.replace(/^\[(.*)\]$/, '$1');
    const host = isIP(bare) === 6 ? `[${bare}]` : bare;
    const user = encodeURIComponent(e.DATABASE_USER ?? '');
    const password = encodeURIComponent(e.DATABASE_PASSWORD ?? '');
    const name = e.DATABASE_NAME ?? '';
    return {
      connectionString: `postgres://${user}:${password}@${host}:${e.DATABASE_PORT}/${encodeURIComponent(name)}`,
      ssl: e.DATABASE_SSL,
      description: `${host}:${e.DATABASE_PORT}/${name}`,
    };
  }

  if (!e.DATABASE_URL && e.APP_ENV === 'production')
    throw new MigrationConfigError('Set DATABASE_HOST (with NAME, USER and PASSWORD) or DATABASE_URL');
  const connectionString = e.DATABASE_URL ?? LOCAL_DATABASE_URL;
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // Never echo the value: it contains the password.
    throw new MigrationConfigError('DATABASE_URL is not a valid URL');
  }
  return {
    connectionString,
    ssl: e.DATABASE_SSL,
    description: `${url.hostname}:${url.port || '5432'}${url.pathname}`,
  };
}

/**
 * Returns the first candidate that holds a drizzle migrations journal. In the API image the SQL
 * files sit next to the bundle (`apps/api/migrations`, where `@lodgent/db` looks once bundled);
 * in a checkout they stay in `packages/db/migrations`.
 */
export function resolveMigrationsFolder(
  candidates: readonly string[],
  exists: (path: string) => boolean = existsSync,
): string {
  const found = candidates.find((dir) => exists(join(dir, 'meta', '_journal.json')));
  if (!found)
    throw new MigrationConfigError(
      `No migrations found: none of ${candidates.join(', ')} contains meta/_journal.json`,
    );
  return found;
}
