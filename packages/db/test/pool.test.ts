import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { Database } from '../src';
import { cloneDatabase } from '../src/testing';

let clone: Awaited<ReturnType<typeof cloneDatabase>>;
let db: Database;
let admin: Database;
const idleErrors: Error[] = [];

beforeAll(async () => {
  clone = await cloneDatabase(inject('databaseUrl'));
  db = new Database({
    connectionString: clone.url,
    applicationName: 'pool-test',
    onIdleError: (e) => idleErrors.push(e),
  });
  admin = new Database({ connectionString: inject('databaseUrl') });
});

afterAll(async () => {
  await db.close();
  await admin.close();
  await clone.drop();
});

it('survives the database dropping idle connections (restart, failover) and reconnects', async () => {
  expect(await db.ping()).toBe(true); // leaves an idle client in the pool
  await admin.pool.query(
    `select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'pool-test'`,
  );
  await expect.poll(() => idleErrors.length).toBeGreaterThan(0);
  expect(await db.ping()).toBe(true);
});
