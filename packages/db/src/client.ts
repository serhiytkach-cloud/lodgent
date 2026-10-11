import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { type SystemRepos, systemRepos } from './repositories/system';
import { type TenantRepos, tenantRepos } from './repositories/tenant';
import * as schema from './schema';

export type Schema = typeof schema;
export type Orm = NodePgDatabase<Schema>;
export type Tx = Parameters<Parameters<Orm['transaction']>[0]>[0];

export interface DatabaseOptions {
  connectionString: string;
  /** Maximum pool size. */
  max?: number;
  /** Require TLS (RDS). */
  ssl?: boolean;
  applicationName?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Entry point for all data access. There is deliberately no way to run a query outside one of
 * the two contexts:
 *  - `tenant(orgId, fn)`: runs as `lodgent_tenant` with `app.org_id` set, so Postgres RLS confines
 *    every statement to that organization, and the repositories filter by org as well.
 *  - `system(fn)`: runs as `lodgent_system` for explicitly cross-tenant work (public catalog,
 *    webhooks, worker scans, sign-in). Call sites should make the reason obvious.
 */
export class Database {
  readonly pool: pg.Pool;
  readonly orm: Orm;

  constructor(options: DatabaseOptions) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      ssl: options.ssl ? { rejectUnauthorized: true } : undefined,
      application_name: options.applicationName,
    });
    this.orm = drizzle(this.pool, { schema });
  }

  async tenant<T>(orgId: string, fn: (repos: TenantRepos) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(orgId)) throw new Error('tenant(): organization id must be a UUID');
    return this.orm.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.org_id', ${orgId}, true), set_config('role', 'lodgent_tenant', true)`,
      );
      return fn(tenantRepos(tx, orgId));
    });
  }

  async system<T>(fn: (repos: SystemRepos) => Promise<T>): Promise<T> {
    return this.orm.transaction(async (tx) => {
      await tx.execute(sql`select set_config('role', 'lodgent_system', true)`);
      return fn(systemRepos(tx));
    });
  }

  async ping(): Promise<boolean> {
    const result = await this.pool.query('select 1 as ok');
    return result.rows[0]?.ok === 1;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
