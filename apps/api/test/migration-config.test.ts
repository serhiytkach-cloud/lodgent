import { describe, expect, it } from 'vitest';
import {
  MigrationConfigError,
  migrationTargetFromEnv,
  resolveMigrationsFolder,
} from '../src/migration-config';

const parts = {
  DATABASE_HOST: 'db.abc123.eu-central-1.rds.amazonaws.com',
  DATABASE_NAME: 'lodgent',
  DATABASE_USER: 'app@user',
  DATABASE_PASSWORD: 'p@ss:w/rd%41?#&=',
};

describe('migrationTargetFromEnv', () => {
  it('builds the URL from the parts with URL-encoded credentials', () => {
    const target = migrationTargetFromEnv({ ...parts, DATABASE_SSL: 'true' });
    const url = new URL(target.connectionString);
    expect(url.hostname).toBe(parts.DATABASE_HOST);
    expect(url.port).toBe('5432');
    expect(decodeURIComponent(url.username)).toBe(parts.DATABASE_USER);
    expect(decodeURIComponent(url.password)).toBe(parts.DATABASE_PASSWORD);
    expect(url.pathname).toBe('/lodgent');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(target.ssl).toBe(true);
    expect(target.description).toBe(`${parts.DATABASE_HOST}:5432/lodgent`);
  });

  it('prefers the parts over DATABASE_URL and honours DATABASE_PORT', () => {
    const target = migrationTargetFromEnv({
      ...parts,
      DATABASE_PORT: '6543',
      DATABASE_URL: 'postgres://other:other@elsewhere:5432/other',
    });
    expect(new URL(target.connectionString).host).toBe(`${parts.DATABASE_HOST}:6543`);
  });

  it('brackets IPv6 hosts', () => {
    const target = migrationTargetFromEnv({ ...parts, DATABASE_HOST: 'fd00::12' });
    expect(new URL(target.connectionString).hostname).toBe('[fd00::12]');
  });

  it('names the missing parts when DATABASE_HOST is set', () => {
    expect(() => migrationTargetFromEnv({ DATABASE_HOST: 'db', DATABASE_NAME: 'x' })).toThrow(
      /DATABASE_USER, DATABASE_PASSWORD/,
    );
  });

  it('rejects a host that would change the URL', () => {
    for (const host of ['evil@db', 'db/other', 'db?sslmode=disable', 'db:5432', 'db name']) {
      expect(() => migrationTargetFromEnv({ ...parts, DATABASE_HOST: host }), host).toThrow(
        MigrationConfigError,
      );
    }
  });

  it('rejects an invalid port', () => {
    expect(() => migrationTargetFromEnv({ ...parts, DATABASE_PORT: '70000' })).toThrow(/DATABASE_PORT/);
  });

  it('uses DATABASE_URL when no host is given', () => {
    const target = migrationTargetFromEnv({
      DATABASE_URL: 'postgres://u:secret@pg.internal:5433/app',
      DATABASE_SSL: 'false',
    });
    expect(target.connectionString).toBe('postgres://u:secret@pg.internal:5433/app');
    expect(target.ssl).toBe(false);
    expect(target.description).toBe('pg.internal:5433/app');
    expect(target.description).not.toContain('secret');
  });

  it('falls back to the local database outside production only', () => {
    expect(migrationTargetFromEnv({}).description).toBe('localhost:5432/lodgent');
    expect(() => migrationTargetFromEnv({ APP_ENV: 'production' })).toThrow(/DATABASE_HOST/);
  });

  it('treats blank values as unset', () => {
    const target = migrationTargetFromEnv({ DATABASE_HOST: ' ', DATABASE_URL: 'postgres://u:p@h:5432/d' });
    expect(target.description).toBe('h:5432/d');
  });

  it('never echoes an invalid DATABASE_URL (it holds the password)', () => {
    try {
      migrationTargetFromEnv({ DATABASE_URL: 'not a url with hunter2' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationConfigError);
      expect((error as Error).message).not.toContain('hunter2');
    }
  });
});

describe('resolveMigrationsFolder', () => {
  it('returns the first folder that holds a migrations journal', () => {
    const present = new Set(['/repo/packages/db/migrations/meta/_journal.json']);
    const folder = resolveMigrationsFolder(
      ['/app/apps/api/migrations', '/repo/packages/db/migrations'],
      (p) => present.has(p),
    );
    expect(folder).toBe('/repo/packages/db/migrations');
  });

  it('fails clearly when no folder has one', () => {
    expect(() => resolveMigrationsFolder(['/nope'], () => false)).toThrow(
      /No migrations found: none of \/nope/,
    );
  });
});
