import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Absolute path of the SQL migrations folder shipped with this package. */
export const migrationsFolder =
  process.env.LODGENT_MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationOptions {
  /** Require TLS and verify the server certificate (RDS), like `DatabaseOptions.ssl`. */
  ssl?: boolean;
}

/**
 * Applies pending migrations. Concurrent runs against the same database (a deploy pipeline and a
 * manual run, say) are serialized with a session advisory lock: drizzle reads the last applied
 * migration before it opens its transaction, so two unserialized runs would both try to apply it.
 */
export async function runMigrations(
  connectionString: string,
  folder = migrationsFolder,
  options: MigrationOptions = {},
): Promise<void> {
  const client = new pg.Client({
    connectionString,
    ssl: options.ssl ? { rejectUnauthorized: true } : undefined,
  });
  await client.connect();
  try {
    await client.query(`select pg_advisory_lock(hashtextextended('schema_migrations', 0))`);
    await migrate(drizzle(client), { migrationsFolder: folder });
  } finally {
    // Ending the session also releases the advisory lock.
    await client.end();
  }
}
