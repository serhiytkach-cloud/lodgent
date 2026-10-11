import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from './migrate';

export const TEST_POSTGRES_IMAGE = 'pgvector/pgvector:0.8.7-pg16';
const TEMPLATE_PREFIX = 'lodgent_tpl_';

export interface TestDatabase {
  /** URL of a fully migrated template database. Use `cloneDatabase` to get a private copy. */
  url: string;
  stop(): Promise<void>;
}

async function adminQuery(serverUrl: string, sql: string): Promise<void> {
  const url = new URL(serverUrl);
  url.pathname = '/postgres';
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function withDatabase(serverUrl: string, name: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Starts Postgres + pgvector and migrates a template database. Uses Testcontainers by default;
 * set TEST_DATABASE_URL to use an existing server instead.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const template = `${TEMPLATE_PREFIX}${randomBytes(4).toString('hex')}`;
  let serverUrl: string;
  let stopServer: () => Promise<void>;

  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    serverUrl = external;
    stopServer = async () => {};
  } else {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    const container = await new PostgreSqlContainer(TEST_POSTGRES_IMAGE)
      .withDatabase('lodgent')
      .withUsername('lodgent')
      .withPassword('lodgent')
      .start();
    serverUrl = container.getConnectionUri();
    stopServer = async () => {
      await container.stop();
    };
  }

  await adminQuery(serverUrl, `create database ${template}`);
  const url = withDatabase(serverUrl, template);
  await runMigrations(url);
  return {
    url,
    async stop() {
      if (external) await adminQuery(serverUrl, `drop database if exists ${template} with (force)`);
      await stopServer();
    },
  };
}

/** Creates a private copy of the migrated template database (a few hundred ms). */
export async function cloneDatabase(templateUrl: string): Promise<{ url: string; drop(): Promise<void> }> {
  const template = new URL(templateUrl).pathname.slice(1);
  const name = `lodgent_test_${randomBytes(6).toString('hex')}`;
  await adminQuery(templateUrl, `create database ${name} template ${template}`);
  return {
    url: withDatabase(templateUrl, name),
    async drop() {
      await adminQuery(templateUrl, `drop database if exists ${name} with (force)`);
    },
  };
}
