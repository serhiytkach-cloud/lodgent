import { parse } from 'pg-connection-string';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

/** Parses the URL with the parser node-postgres uses, so the test proves what the pool will see. */
function parsePg(url: string) {
  const { user, password, host, port, database, ssl } = parse(url);
  return { user, password, host, port, database, ssl };
}

const parts = {
  DATABASE_HOST: 'lodgent-prod-db.abc123.eu-central-1.rds.amazonaws.com',
  DATABASE_PORT: '5432',
  DATABASE_NAME: 'lodgent',
  DATABASE_USER: 'lodgent_admin',
  // Characters with a meaning in URLs, plus a literal "%41" that must not be decoded to "A".
  DATABASE_PASSWORD: 'p@ss:w/rd?#%41&=+ ~[]',
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
      password: parts.DATABASE_PASSWORD,
      host: parts.DATABASE_HOST,
      port: '5432',
      database: 'lodgent',
      ssl: undefined,
    });
  });

  it('percent-encodes reserved characters in the user and password', () => {
    const { database } = loadConfig({ ...parts, DATABASE_USER: 'app:user@x' });
    expect(database.url).toContain('//app%3Auser%40x:p%40ss%3Aw%2Frd%3F%23%2541%26%3D%2B%20~%5B%5D@');
    expect(parsePg(database.url)).toMatchObject({ user: 'app:user@x', password: parts.DATABASE_PASSWORD });
  });

  it('defaults the port to 5432 and honours an explicit one', () => {
    const withoutPort = loadConfig({ ...parts, DATABASE_PORT: undefined });
    expect(parsePg(withoutPort.database.url).port).toBe('5432');
    const custom = loadConfig({ ...parts, DATABASE_PORT: '6432' });
    expect(parsePg(custom.database.url).port).toBe('6432');
  });

  it('accepts IP addresses, bracketing IPv6', () => {
    expect(parsePg(loadConfig({ ...parts, DATABASE_HOST: '10.0.3.17' }).database.url).host).toBe('10.0.3.17');
    for (const host of ['fd00::17', '[fd00::17]']) {
      const { url } = loadConfig({ ...parts, DATABASE_HOST: host }).database;
      expect(url).toContain('@[fd00::17]:5432/');
      expect(parsePg(url).host).toBe('fd00::17');
    }
  });

  it('leaves TLS to DATABASE_SSL, as with DATABASE_URL (no sslmode in the URL)', () => {
    const tls = loadConfig({ ...parts, DATABASE_SSL: 'true' }).database;
    expect(tls.ssl).toBe(true);
    // node-postgres would let a URL sslmode replace the pool's explicit `ssl` options.
    expect(new URL(tls.url).search).toBe('');
    expect(parsePg(tls.url).ssl).toBeUndefined();
    expect(loadConfig(parts).database.ssl).toBe(false);
  });

  it('refuses incomplete parts', () => {
    expect(() => loadConfig({ ...parts, DATABASE_PASSWORD: undefined })).toThrow(/DATABASE_PASSWORD/);
    expect(() => loadConfig({ ...parts, DATABASE_USER: '' })).toThrow(/DATABASE_USER/);
    expect(() => loadConfig({ ...parts, DATABASE_NAME: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...parts, DATABASE_PORT: 'not-a-port' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...parts, DATABASE_PORT: '70000' })).toThrow(ConfigError);
  });

  it('refuses a host that carries credentials, a port or a path', () => {
    for (const host of ['evil@db.internal', 'db.internal:5433', 'db.internal/other', 'db internal']) {
      expect(() => loadConfig({ ...parts, DATABASE_HOST: host }), host).toThrow(/DATABASE_HOST/);
    }
  });

  it('builds the URL in production with the parts ECS injects', () => {
    const config = loadConfig({
      ...parts,
      APP_ENV: 'production',
      DATABASE_SSL: 'true',
      AUTH_PROVIDER: 'cognito',
      COGNITO_USER_POOL_ID: 'eu-central-1_abc',
      COGNITO_CLIENT_ID: 'client',
      KMS_PROVIDER: 'aws',
      KMS_KEY_ID: 'arn:aws:kms:eu-central-1:111122223333:key/abc',
      INTERNAL_API_TOKEN: 'internal-token-for-tests',
      SIGNING_SECRET: 'signing-secret-for-tests-0123456789abcdef',
      STRIPE_SECRET_KEY: 'sk_test_not_a_real_key',
      STRIPE_WEBHOOK_SECRET: 'whsec_not_a_real_secret',
      APALEO_CLIENT_ID: 'apaleo-client',
      APALEO_WEBHOOK_TOKEN: 'apaleo-webhook-token-for-tests',
    });
    expect(config.database).toMatchObject({ ssl: true });
    expect(parsePg(config.database.url)).toMatchObject({ host: parts.DATABASE_HOST, user: 'lodgent_admin' });
  });
});
