import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** Absolute path of the SQL migrations folder shipped with this package. */
export const migrationsFolder =
  process.env.LODGENT_MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function runMigrations(connectionString: string, folder = migrationsFolder): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
  }
}
