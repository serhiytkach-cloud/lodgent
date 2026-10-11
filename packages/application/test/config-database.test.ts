import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

/** Parses a connection URL the way pg-connection-string does (WHATWG URL + decodeURIComponent). */
function parsePg(url: string) {
  const parsed = new URL(url);
  return {
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: parsed.hostname,
    port: parsed.port,
    database: decodeURI(parsed.pathname.slice(1)),
    sslmode: parsed.searchParams.get('sslmode'),
  };
}

const parts = {
  DATABASE_HOST: 'lodgent-prod-db.abc123.eu-central-1.rds.amazonaws.com',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'lodgent',
  DATABASE_USER: 'lodgent_admin',
  DATABASE_PASSWORD: 'p@ss:w/rd?#%41&=+ ',
};

describe('database configuration', () => {
  it('uses DATABASE_URL when DATABASE_HOST is not set', () => {
    const config = loadConfig({ DATABASE_URL: 'postgres://u:p@db.internal:6543/app' });
    expect(config.database.url).toBe('postgres://u:p@db.internal:6543/app');
  });

  it('keeps the local default when nothing is set', () => {
    expect(loadConfig({}).database.url).toBe('postgres://lodgent:lodgent@localhost:5432/lodgent');
  });

  it('treats a blank DATABASE_HOST as unset', () => {
    const config = loadConfig({ DATABASE_HOST: ' ', DATABASE_URL: 'postgres://u:p@h:5432/d' });
    expect(config.database.url).toBe('postgres://u:p@h:5432/d');
  });

  it('builds the URL from parts and prefers them over DATABASE_URL', () => {
    const config = loadConfig({ ...parts, DATABASE_URL: 'postgres://ignored@elsewhere/x' });
    expect(parsePg(config.database.url)).toEqual({
      user: 'lodgent_admin',
      password: 'p@ss:w/rd?#%41&=+ ',
      host: parts.DATABASE_HOST,
      port: '5432',
      database: 'lodgent',
      sslmode: null,
    });
  });

  it('percent-encodes reserved characters in the user and password', () => {
    const { database } = loadConfig({ ...parts, DATABASE_USER: 'app:user@x' });
    expect(database.url).toContain('app%3Auser%40x:p%40ss%3Aw%2Frd%3F%23%2541%26%3D%2B%20@');
    expect(parsePg(database.url).user).toBe('app:user@x');
  });

  it('defaults the port to 5432 and honours an explicit one', () => {
    const withoutPort = loadConfig({ ...parts, DATABASE_PORT: undefined });
    expect(parsePg(withoutPort.database.url).port).toBe('5432');
    const custom = loadConfig({ ...parts, DATABASE_PORT: '6432' });
    expect(parsePg(custom.database.url).port).toBe('6432');
  });

  it('requires TLS with full verification in the URL when DATABASE_SSL is on', () => {
    const config = loadConfig({ ...parts, DATABASE_SSL: 'true' });
    expect(config.database.ssl).toBe(true);
    expect(parsePg(config.database.url).sslmode).toBe('verify-full');
  });

  it('refuses incomplete parts', () => {
    expect(() => loadConfig({ ...parts, DATABASE_PASSWORD: undefined })).toThrow(/DATABASE_PASSWORD/);
    expect(() => loadConfig({ ...parts, DATABASE_USER: '' })).toThrow(/DATABASE_USER/);
    expect(() => loadConfig({ ...parts, DATABASE_NAME: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...parts, DATABASE_PORT: 'not-a-port' })).toThrow(ConfigError);
  });
});
