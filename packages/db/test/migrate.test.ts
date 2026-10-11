import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { migrationsFolder, runMigrations } from '../src';

const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
  entries: unknown[];
};

let serverUrl: URL;
let databaseUrl: string;
const name = `lodgent_migrate_${randomBytes(6).toString('hex')}`;

async function admin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: serverUrl.toString() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function appliedMigrations(): Promise<number> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ count: string }>(
      'select count(*) as count from drizzle.__drizzle_migrations',
    );
    return Number(result.rows[0]?.count);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  serverUrl = new URL(inject('databaseUrl'));
  serverUrl.pathname = '/postgres';
  await admin(`create database ${name}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  databaseUrl = url.toString();
});

afterAll(async () => {
  await admin(`drop database if exists ${name} with (force)`);
});

it('applies every migration exactly once when runs race, and re-runs as a no-op', async () => {
  await Promise.all([runMigrations(databaseUrl), runMigrations(databaseUrl), runMigrations(databaseUrl)]);
  expect(await appliedMigrations()).toBe(journal.entries.length);

  await runMigrations(databaseUrl);
  expect(await appliedMigrations()).toBe(journal.entries.length);
});
