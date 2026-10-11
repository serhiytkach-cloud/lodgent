import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { Database } from '../src';
import { cloneDatabase } from '../src/testing';

let db: Database;
let drop: () => Promise<void>;
let orgA: string;
let orgB: string;
let propertyA: string;
let propertyB: string;
let userA: string;
let userB: string;

const now = new Date();

/** Drizzle wraps driver errors ("Failed query: …"); the Postgres message is on `cause`. */
async function pgError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? String(error);
  }
  throw new Error('Expected the query to fail');
}

beforeAll(async () => {
  const clone = await cloneDatabase(inject('databaseUrl'));
  drop = clone.drop;
  db = new Database({ connectionString: clone.url });
  const suffix = randomUUID().slice(0, 8);
  await db.system(async ({ identity }) => {
    userA = (
      await identity.upsertUser({ authSubject: `dev:a-${suffix}`, email: `a-${suffix}@example.com` }, now)
    ).id;
    userB = (
      await identity.upsertUser({ authSubject: `dev:b-${suffix}`, email: `b-${suffix}@example.com` }, now)
    ).id;
    orgA = (await identity.createOrganization({ name: 'Org A', slug: `org-a-${suffix}` }, userA)).id;
    orgB = (await identity.createOrganization({ name: 'Org B', slug: `org-b-${suffix}` }, userB)).id;
  });
  propertyA = await db.tenant(
    orgA,
    async (r) => (await r.properties.create({ name: 'Hotel A', slug: `a-${suffix}` })).id,
  );
  propertyB = await db.tenant(
    orgB,
    async (r) => (await r.properties.create({ name: 'Hotel B', slug: `b-${suffix}` })).id,
  );
});

afterAll(async () => {
  await db.close();
  await drop();
});

describe('tenant isolation', () => {
  it('repositories only return the current organization', async () => {
    const list = await db.tenant(orgA, (r) => r.properties.list());
    expect(list.map((p) => p.id)).toEqual([propertyA]);
    expect(await db.tenant(orgA, (r) => r.properties.get(propertyB))).toBeUndefined();
  });

  it('RLS hides other organizations even from raw SQL', async () => {
    const rows = await db.tenant(
      orgA,
      async ({ tx }) => (await tx.execute(sql`select id from properties`)).rows,
    );
    expect(rows.map((r) => r.id)).toEqual([propertyA]);

    const orgs = await db.tenant(
      orgA,
      async ({ tx }) => (await tx.execute(sql`select id from organizations`)).rows,
    );
    expect(orgs.map((r) => r.id)).toEqual([orgA]);

    const users = await db.tenant(orgA, async ({ tx }) => (await tx.execute(sql`select id from users`)).rows);
    expect(users.map((r) => r.id)).toEqual([userA]);

    const members = await db.tenant(
      orgA,
      async ({ tx }) => (await tx.execute(sql`select user_id from memberships`)).rows,
    );
    expect(members.map((r) => r.user_id)).toEqual([userA]);
  });

  it('RLS rejects writes into another organization', async () => {
    const message = await pgError(
      db.tenant(orgA, ({ tx }) =>
        tx.execute(
          sql`insert into properties (organization_id, name, slug) values (${orgB}, 'Sneaky', ${`x-${randomUUID()}`})`,
        ),
      ),
    );
    expect(message).toMatch(/row-level security/);
  });

  it('RLS turns cross-tenant updates and deletes into no-ops', async () => {
    const updated = await db.tenant(orgA, ({ tx }) =>
      tx.execute(sql`update properties set name = 'Hijacked' where id = ${propertyB}`),
    );
    expect(updated.rowCount).toBe(0);
    const deleted = await db.tenant(orgA, ({ tx }) =>
      tx.execute(sql`delete from properties where id = ${propertyB}`),
    );
    expect(deleted.rowCount).toBe(0);
    const stillThere = await db.tenant(orgB, (r) => r.properties.get(propertyB));
    expect(stillThere?.name).toBe('Hotel B');
  });

  it('RLS blocks moving a row to another organization', async () => {
    const message = await pgError(
      db.tenant(orgA, ({ tx }) =>
        tx.execute(sql`update properties set organization_id = ${orgB} where id = ${propertyA}`),
      ),
    );
    expect(message).toMatch(/row-level security/);
  });

  it('a tenant transaction without an organization sees nothing', async () => {
    const rows = await db.orm.transaction(async (tx) => {
      await tx.execute(sql`select set_config('role', 'lodgent_tenant', true)`);
      return (await tx.execute(sql`select id from properties`)).rows;
    });
    expect(rows).toEqual([]);
  });

  it('tenants cannot touch the job queue', async () => {
    const message = await pgError(db.tenant(orgA, ({ tx }) => tx.execute(sql`select * from jobs`)));
    expect(message).toMatch(/permission denied/);
  });

  it('the system context sees every organization', async () => {
    const rows = await db.system(
      async ({ tx }) =>
        (await tx.execute(sql`select id from properties where id in (${propertyA}, ${propertyB})`)).rows,
    );
    expect(rows).toHaveLength(2);
  });

  it('every table with organization_id has RLS and a tenant policy', async () => {
    const result = await db.system(({ tx }) =>
      tx.execute(sql`
        select c.relname as table, c.relrowsecurity as rls,
               exists (select 1 from pg_policies p where p.tablename = c.relname and p.policyname = 'tenant_isolation') as policy
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        where c.relkind = 'r'
          and exists (select 1 from information_schema.columns col
                      where col.table_schema = 'public' and col.table_name = c.relname
                        and col.column_name = 'organization_id')`),
    );
    const unprotected = result.rows.filter((r) => !(r.rls && r.policy)).map((r) => r.table);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(unprotected).toEqual([]);
  });
});
