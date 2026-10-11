import { createHmac, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertProductionReady, ConfigError, DEV_SECRETS, loadConfig } from '../src/config';
import { Signer } from '../src/infra/signing';
import { isWellFormedApiKey } from '../src/services/agent-clients';
import { hashToken, newToken } from '../src/services/members';

const ROOT = 'test-root-secret-7f3a9c1e5b2d8046aa1b2c3d4e5f6071';

describe('signed tokens', () => {
  const signer = new Signer(ROOT);
  const now = new Date('2026-10-11T12:00:00Z');

  it('round-trips a payload until it expires', () => {
    const token = signer.sign('checkout', { h: 'hold-1' }, 60, now);
    expect(signer.verify('checkout', token, now)).toMatchObject({ h: 'hold-1' });
    expect(signer.verify('checkout', token, new Date(now.getTime() + 61_000))).toBeNull();
  });

  it('binds tokens to their purpose and root secret', () => {
    const token = signer.sign('oauth-state', { orgId: 'o' }, 60, now);
    expect(signer.verify('checkout', token, now)).toBeNull();
    expect(new Signer(`${ROOT}-other`).verify('oauth-state', token, now)).toBeNull();
  });

  it('rejects tampered, re-encoded and malformed tokens', () => {
    const token = signer.sign('checkout', { h: 'hold-1' }, 60, now);
    const [body, mac] = token.split('.') as [string, string];
    const forgedBody = Buffer.from(JSON.stringify({ h: 'hold-2', exp: 9_999_999_999 })).toString('base64url');
    const flip = (s: string) => `${s.slice(0, -1)}${s.endsWith('A') ? 'B' : 'A'}`;
    for (const bad of [
      `${forgedBody}.${mac}`,
      `${body}.${flip(mac)}`,
      `${body}.${mac}.extra`,
      `${body}.${mac}=`,
      `${body}.${mac}!`,
      `${body}.`,
      `.${mac}`,
      body,
      '',
      'x'.repeat(5000),
    ]) {
      expect(signer.verify('checkout', bad, now), bad.slice(0, 40)).toBeNull();
    }
  });

  it('requires an object payload with a numeric expiry', () => {
    // Correctly MACed tokens (same key derivation as Signer) whose payloads Signer never produces.
    const forge = (payload: string) => {
      const key = Buffer.from(hkdfSync('sha256', ROOT, 'lodgent', 'checkout', 32));
      const body = Buffer.from(payload).toString('base64url');
      return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
    };
    const future = Math.floor(now.getTime() / 1000) + 60;
    expect(signer.verify('checkout', forge(JSON.stringify({ h: 'x', exp: future })), now)).toMatchObject({
      h: 'x',
    });
    for (const payload of [
      '[1]',
      'null',
      '"text"',
      'not json',
      JSON.stringify({ h: 'x' }),
      JSON.stringify({ h: 'x', exp: String(future) }),
    ]) {
      expect(signer.verify('checkout', forge(payload), now), payload).toBeNull();
    }
    expect(() => new Signer('too-short')).toThrow();
  });
});

describe('random tokens and key hashing', () => {
  it('uses 256-bit tokens', () => {
    expect(Buffer.from(newToken(), 'base64url')).toHaveLength(32);
    expect(newToken()).not.toBe(newToken());
  });

  it('stores only SHA-256 hashes of tokens', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('only looks up well-formed partner keys', () => {
    expect(isWellFormedApiKey(`lodgent_live_${newToken(32)}`)).toBe(true);
    for (const bad of [
      '',
      'lodgent_live_short',
      `other_live_${newToken(32)}`,
      `lodgent_live_${newToken(32)}' OR 1=1 --`,
      `lodgent_live_${'a'.repeat(5000)}`,
    ]) {
      expect(isWellFormedApiKey(bad), bad.slice(0, 30)).toBe(false);
    }
  });
});

/** A complete, valid production environment (all values fake). */
function productionEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    APP_ENV: 'production',
    WEB_BASE_URL: 'https://app.hotel-direct.example',
    API_BASE_URL: 'https://api.hotel-direct.example',
    DATABASE_URL: 'postgres://app_user:Xk2p9QwLm4Rt7Zs1@db.internal:5432/app',
    DATABASE_SSL: 'true',
    AUTH_PROVIDER: 'cognito',
    COGNITO_USER_POOL_ID: 'eu-central-1_TESTPOOL',
    COGNITO_CLIENT_ID: 'testclientid',
    AUTH_DEV_SECRET: 'unused-in-prod-Q8w7E6r5T4y3U2i1O0pAsDfGhJkL',
    INTERNAL_API_TOKEN: 'internal-Z9x8C7v6B5n4M3q2W1e0RtYuIoPaSdF',
    SIGNING_SECRET: 'signing-H7g6F5d4S3a2Q1w0E9r8T7y6U5i4O3p',
    KMS_PROVIDER: 'aws',
    KMS_KEY_ID: 'alias/test',
    QUEUE_PROVIDER: 'sqs',
    SQS_QUEUE_URL: 'https://sqs.eu-central-1.amazonaws.com/000000000000/test-jobs',
    EMAIL_PROVIDER: 'ses',
    EMAIL_FROM: 'Bookings <bookings@hotel-direct.example>',
    APALEO_CLIENT_ID: 'TEST-CLIENT',
    APALEO_CLIENT_SECRET: 'test-apaleo-client-secret',
    APALEO_IDENTITY_URL: 'https://identity.apaleo.com',
    APALEO_API_URL: 'https://api.apaleo.com',
    APALEO_WEBHOOK_URL: 'https://webhook.apaleo.com',
    APALEO_WEBHOOK_TOKEN: 'webhook-M1n2B3v4C5x6Z7l8K9j0H1g2F3d4S5a',
    STRIPE_SECRET_KEY: 'sk_test_notarealkey000000000000',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_notarealkey000000000000',
    STRIPE_WEBHOOK_SECRET: 'whsec_notarealsecret0000000000',
    ...overrides,
  };
}

describe('production configuration', () => {
  it('accepts a complete production environment', () => {
    const config = loadConfig(productionEnv());
    expect(config.isProduction).toBe(true);
    expect(config.crawler.allowPrivateNetworks).toBe(false);
  });

  it('refuses development defaults (reporting every problem at once)', () => {
    try {
      loadConfig({ APP_ENV: 'production' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      for (const name of [
        'AUTH_PROVIDER',
        'AUTH_DEV_SECRET',
        'KMS_PROVIDER',
        'INTERNAL_API_TOKEN',
        'SIGNING_SECRET',
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
        'APALEO_CLIENT_ID',
        'APALEO_WEBHOOK_TOKEN',
        'WEB_BASE_URL',
        'DATABASE_SSL',
        'database login',
        'local mail catcher',
      ]) {
        expect(message).toContain(name);
      }
    }
  });

  it.each([
    ['AUTH_PROVIDER', { AUTH_PROVIDER: 'dev' }, /AUTH_PROVIDER must be cognito/],
    [
      'AUTH_DEV_SECRET',
      { AUTH_DEV_SECRET: DEV_SECRETS.authDevSecret },
      /AUTH_DEV_SECRET uses the dev default/,
    ],
    ['AUTH_DEV_SECRET blank', { AUTH_DEV_SECRET: '' }, /AUTH_DEV_SECRET uses the dev default/],
    ['KMS_PROVIDER', { KMS_PROVIDER: 'local' }, /KMS_PROVIDER must be aws/],
    [
      'LOCAL_KMS_MASTER_KEY',
      { KMS_PROVIDER: 'local', LOCAL_KMS_MASTER_KEY: DEV_SECRETS.localKmsMasterKey },
      /KMS_PROVIDER must be aws/,
    ],
    [
      'INTERNAL_API_TOKEN default',
      { INTERNAL_API_TOKEN: DEV_SECRETS.internalApiToken },
      /INTERNAL_API_TOKEN uses the dev default/,
    ],
    [
      'INTERNAL_API_TOKEN short',
      { INTERNAL_API_TOKEN: 'short-token-123' },
      /INTERNAL_API_TOKEN must be at least 32/,
    ],
    [
      'SIGNING_SECRET default',
      { SIGNING_SECRET: DEV_SECRETS.signingSecret },
      /SIGNING_SECRET uses the dev default/,
    ],
    [
      'SIGNING_SECRET patterned',
      { SIGNING_SECRET: 'abababababababababababababababababab' },
      /SIGNING_SECRET must be at least 32 random/,
    ],
    ['shared secrets', { INTERNAL_API_TOKEN: 'signing-H7g6F5d4S3a2Q1w0E9r8T7y6U5i4O3p' }, /must all differ/],
    ['STRIPE_SECRET_KEY', { STRIPE_SECRET_KEY: DEV_SECRETS.stripeSecretKey }, /STRIPE_SECRET_KEY is not set/],
    [
      'STRIPE_PUBLISHABLE_KEY',
      { STRIPE_PUBLISHABLE_KEY: DEV_SECRETS.stripePublishableKey },
      /STRIPE_PUBLISHABLE_KEY/,
    ],
    [
      'STRIPE_WEBHOOK_SECRET',
      { STRIPE_WEBHOOK_SECRET: DEV_SECRETS.stripeWebhookSecret },
      /STRIPE_WEBHOOK_SECRET/,
    ],
    [
      'STRIPE_CONNECT_WEBHOOK_SECRET',
      { STRIPE_CONNECT_WEBHOOK_SECRET: 'not-a-whsec' },
      /STRIPE_WEBHOOK_SECRET/,
    ],
    ['STRIPE_API_BASE_URL', { STRIPE_API_BASE_URL: 'http://localhost:4020' }, /STRIPE_API_BASE_URL/],
    [
      'APALEO_CLIENT_SECRET',
      { APALEO_CLIENT_SECRET: DEV_SECRETS.apaleoClientSecret },
      /APALEO_CLIENT_SECRET/,
    ],
    ['APALEO_WEBHOOK_TOKEN', { APALEO_WEBHOOK_TOKEN: 'short' }, /APALEO_WEBHOOK_TOKEN must be at least 32/],
    ['APALEO_API_URL', { APALEO_API_URL: 'http://api.apaleo.com' }, /must use https/],
    ['WEB_BASE_URL', { WEB_BASE_URL: 'http://app.example' }, /WEB_BASE_URL must use https/],
    ['API_BASE_URL', { API_BASE_URL: 'http://api.example' }, /API_BASE_URL must use https/],
    ['DATABASE_SSL', { DATABASE_SSL: 'false' }, /DATABASE_SSL must be true/],
    [
      'DATABASE_URL',
      { DATABASE_URL: 'postgres://lodgent:lodgent@db:5432/lodgent' },
      /development credentials/,
    ],
    ['AWS_ENDPOINT_URL', { AWS_ENDPOINT_URL: 'http://localhost:4566' }, /AWS_ENDPOINT_URL/],
    ['SMTP', { EMAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://localhost:1025' }, /mail catcher/],
    [
      'CRAWL_ALLOW_PRIVATE_NETWORKS',
      { CRAWL_ALLOW_PRIVATE_NETWORKS: 'true' },
      /CRAWL_ALLOW_PRIVATE_NETWORKS/,
    ],
  ])('refuses %s', (_name, overrides, problem) => {
    expect(() => loadConfig(productionEnv(overrides))).toThrow(problem);
  });

  it('can be asserted on an already loaded config', () => {
    const config = loadConfig(productionEnv());
    expect(() => assertProductionReady(config)).not.toThrow();
    expect(() => assertProductionReady({ ...config, signingSecret: DEV_SECRETS.signingSecret })).toThrow(
      ConfigError,
    );
  });
});
