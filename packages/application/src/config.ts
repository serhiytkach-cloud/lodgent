import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(blank, z.string().optional());
const optionalUrl = z.preprocess(blank, z.url().optional());
const bool = (fallback: boolean) => z.preprocess(blank, z.stringbool().default(fallback));
const int = (fallback: number) => z.preprocess(blank, z.coerce.number().int().default(fallback));

/** Development-only defaults. Production refuses to start with any of these. */
export const DEV_SECRETS = {
  authDevSecret: 'dev-only-auth-secret-change-me-0123456789abcdef',
  localKmsMasterKey: 'ZGV2LW9ubHktbG9jYWwta21zLWtleS0zMi1ieXRlcyE=',
  internalApiToken: 'dev-internal-token',
  signingSecret: 'dev-only-signing-secret-0123456789abcdefghij',
  stripeSecretKey: 'sk_test_lodgent_fake',
  stripePublishableKey: 'pk_test_lodgent_fake',
  stripeWebhookSecret: 'whsec_lodgent_fake_0123456789abcdef',
  apaleoClientId: 'lodgent-fake-client',
  apaleoClientSecret: 'lodgent-fake-secret',
} as const;

const EnvSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WEB_BASE_URL: z.url().default('http://localhost:3000'),
  API_BASE_URL: z.url().default('http://localhost:4000'),
  API_PORT: int(4000),
  INTERNAL_API_TOKEN: z.preprocess(blank, z.string().min(8).default(DEV_SECRETS.internalApiToken)),

  DATABASE_URL: z.string().default('postgres://lodgent:lodgent@localhost:5432/lodgent'),
  DATABASE_SSL: bool(false),
  DATABASE_POOL_MAX: int(10),

  AUTH_PROVIDER: z.enum(['dev', 'cognito']).default('dev'),
  AUTH_DEV_SECRET: z.preprocess(blank, z.string().min(32).default(DEV_SECRETS.authDevSecret)),
  COGNITO_USER_POOL_ID: optionalString,
  COGNITO_CLIENT_ID: optionalString,

  AWS_REGION: z.string().default('eu-central-1'),
  AWS_ENDPOINT_URL: optionalUrl,

  KMS_PROVIDER: z.enum(['local', 'aws']).default('local'),
  LOCAL_KMS_MASTER_KEY: z.string().default(DEV_SECRETS.localKmsMasterKey),
  KMS_KEY_ID: optionalString,

  QUEUE_PROVIDER: z.enum(['pg', 'sqs']).default('pg'),
  SQS_QUEUE_URL: optionalUrl,

  EMAIL_PROVIDER: z.enum(['smtp', 'ses']).default('smtp'),
  SMTP_URL: z.string().default('smtp://localhost:1025'),
  EMAIL_FROM: z.string().default('Lodgent Bookings <bookings@lodgent.local>'),

  APALEO_CLIENT_ID: z.string().default(DEV_SECRETS.apaleoClientId),
  APALEO_CLIENT_SECRET: z.string().default(DEV_SECRETS.apaleoClientSecret),
  APALEO_IDENTITY_URL: z.url().default('http://localhost:4010'),
  APALEO_API_URL: z.url().default('http://localhost:4010'),
  APALEO_WEBHOOK_URL: z.url().default('http://localhost:4010'),
  /** Shared secret Apaleo sends back on webhook calls (embedded in the subscription's endpoint URL). */
  APALEO_WEBHOOK_TOKEN: z.string().default('dev-apaleo-webhook-token'),
  /** Space-separated OAuth scopes; must match the app registration in the Apaleo store. */
  APALEO_SCOPES: optionalString,
  /** Channel Apaleo offers and bookings use. Rate plans must be distributed on it. */
  APALEO_CHANNEL_CODE: z.enum(['Ibe', 'Direct']).default('Ibe'),
  /** Deep link to a reservation in the Apaleo app; `{propertyId}` and `{reservationId}` are replaced. */
  APALEO_RESERVATION_URL_TEMPLATE: optionalString,

  STRIPE_SECRET_KEY: z.string().default(DEV_SECRETS.stripeSecretKey),
  STRIPE_PUBLISHABLE_KEY: z.string().default(DEV_SECRETS.stripePublishableKey),
  STRIPE_WEBHOOK_SECRET: z.string().default(DEV_SECRETS.stripeWebhookSecret),
  /** Secret of the Connect webhook endpoint (events from hotels' accounts), if it differs. */
  STRIPE_CONNECT_WEBHOOK_SECRET: optionalString,
  /** Points the Stripe SDK at the local fake Stripe server. Leave blank for api.stripe.com. */
  STRIPE_API_BASE_URL: optionalUrl,

  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: z.string().default('gpt-5.2'),
  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: z.string().default('gemini-3-flash'),
  PERPLEXITY_API_KEY: optionalString,
  PERPLEXITY_MODEL: z.string().default('sonar-pro'),
  EMBEDDINGS_PROVIDER: z.enum(['local', 'openai', 'voyage']).default('local'),
  VOYAGE_API_KEY: optionalString,

  DEFAULT_FEE_BPS: int(200),
  HOLD_TTL_MINUTES: int(15),
  OFFER_CACHE_TTL_SECONDS: int(60),
  OFFER_VALIDITY_MINUTES: int(30),
  /** Root secret for signed tokens (OAuth state, checkout links); per-purpose keys are derived from it. */
  SIGNING_SECRET: z.preprocess(blank, z.string().min(32).default(DEV_SECRETS.signingSecret)),
  PII_RETENTION_DAYS: int(30),
  VISIBILITY_RAW_RETENTION_DAYS: int(90),
  VISIBILITY_DEFAULT_MONTHLY_CAP_CENTS: int(5000),
  ANONYMOUS_RATE_LIMIT_PER_MINUTE: int(30),
  PARTNER_RATE_LIMIT_PER_MINUTE: int(300),
  /** Lets the website crawler reach localhost/private networks. Defaults to on outside production (local demo sites). */
  CRAWL_ALLOW_PRIVATE_NETWORKS: z.preprocess(blank, z.stringbool().optional()),

  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env['APP_ENV'];
  isProduction: boolean;
  logLevel: Env['LOG_LEVEL'];
  webBaseUrl: string;
  apiBaseUrl: string;
  apiPort: number;
  internalApiToken: string;
  database: { url: string; ssl: boolean; poolMax: number };
  auth:
    | { provider: 'dev'; devSecret: string }
    | { provider: 'cognito'; userPoolId: string; clientId: string; devSecret: string };
  aws: { region: string; endpointUrl?: string };
  kms: { provider: 'local'; masterKey: string } | { provider: 'aws'; keyId: string };
  queue: { provider: 'pg' } | { provider: 'sqs'; queueUrl: string };
  email: { provider: 'smtp'; smtpUrl: string; from: string } | { provider: 'ses'; from: string };
  apaleo: {
    clientId: string;
    clientSecret: string;
    identityUrl: string;
    apiUrl: string;
    webhookUrl: string;
    webhookToken: string;
    redirectUri: string;
    scopes: string[] | null;
    channelCode: 'Ibe' | 'Direct';
    reservationUrlTemplate: string;
  };
  stripe: {
    secretKey: string;
    publishableKey: string;
    webhookSecrets: string[];
    apiBaseUrl?: string;
    /** The hotel's own Stripe Dashboard (direct charges live there); null with the local fake. */
    dashboardUrl: string | null;
  };
  llm: {
    anthropic?: { apiKey: string; model: string };
    openai?: { apiKey: string; model: string };
    gemini?: { apiKey: string; model: string };
    perplexity?: { apiKey: string; model: string };
    extractionModel: string;
    embeddings:
      | { provider: 'local' }
      | { provider: 'openai'; apiKey: string }
      | { provider: 'voyage'; apiKey: string };
  };
  business: {
    defaultFeeBps: number;
    holdTtlMinutes: number;
    offerCacheTtlSeconds: number;
    offerValidityMinutes: number;
    piiRetentionDays: number;
    visibilityRawRetentionDays: number;
    visibilityDefaultMonthlyCapCents: number;
  };
  rateLimits: { anonymousPerMinute: number; partnerPerMinute: number };
  signingSecret: string;
  crawler: { allowPrivateNetworks: boolean };
  otelEndpoint?: string;
}

/** Loads `.env` from the repository root (if present) for local development. Real env wins. */
export function loadDotEnv(startDir = process.cwd()): void {
  let dir = resolve(startDir);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.env');
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      if (existsSync(candidate)) process.loadEnvFile(candidate);
      return;
    }
    dir = dirname(dir);
  }
}

export class ConfigError extends Error {}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.APP_ENV === 'production';

  // With the development placeholder key, talk to the local fake Stripe; a real key talks to Stripe.
  const stripeApiBaseUrl =
    e.STRIPE_API_BASE_URL ??
    (e.STRIPE_SECRET_KEY === DEV_SECRETS.stripeSecretKey ? 'http://localhost:4020' : undefined);
  const config: AppConfig = {
    env: e.APP_ENV,
    isProduction,
    logLevel: e.LOG_LEVEL,
    webBaseUrl: stripSlash(e.WEB_BASE_URL),
    apiBaseUrl: stripSlash(e.API_BASE_URL),
    apiPort: e.API_PORT,
    internalApiToken: e.INTERNAL_API_TOKEN,
    database: { url: e.DATABASE_URL, ssl: e.DATABASE_SSL, poolMax: e.DATABASE_POOL_MAX },
    auth:
      e.AUTH_PROVIDER === 'cognito'
        ? {
            provider: 'cognito',
            userPoolId: required(e.COGNITO_USER_POOL_ID, 'COGNITO_USER_POOL_ID'),
            clientId: required(e.COGNITO_CLIENT_ID, 'COGNITO_CLIENT_ID'),
            devSecret: e.AUTH_DEV_SECRET,
          }
        : { provider: 'dev', devSecret: e.AUTH_DEV_SECRET },
    aws: { region: e.AWS_REGION, endpointUrl: e.AWS_ENDPOINT_URL },
    kms:
      e.KMS_PROVIDER === 'aws'
        ? { provider: 'aws', keyId: required(e.KMS_KEY_ID, 'KMS_KEY_ID') }
        : { provider: 'local', masterKey: e.LOCAL_KMS_MASTER_KEY },
    queue:
      e.QUEUE_PROVIDER === 'sqs'
        ? { provider: 'sqs', queueUrl: required(e.SQS_QUEUE_URL, 'SQS_QUEUE_URL') }
        : { provider: 'pg' },
    email:
      e.EMAIL_PROVIDER === 'ses'
        ? { provider: 'ses', from: e.EMAIL_FROM }
        : { provider: 'smtp', smtpUrl: e.SMTP_URL, from: e.EMAIL_FROM },
    apaleo: {
      clientId: e.APALEO_CLIENT_ID,
      clientSecret: e.APALEO_CLIENT_SECRET,
      identityUrl: stripSlash(e.APALEO_IDENTITY_URL),
      apiUrl: stripSlash(e.APALEO_API_URL),
      webhookUrl: stripSlash(e.APALEO_WEBHOOK_URL),
      webhookToken: e.APALEO_WEBHOOK_TOKEN,
      redirectUri: `${stripSlash(e.API_BASE_URL)}/v1/integrations/apaleo/callback`,
      scopes: e.APALEO_SCOPES ? e.APALEO_SCOPES.split(/\s+/).filter(Boolean) : null,
      channelCode: e.APALEO_CHANNEL_CODE,
      reservationUrlTemplate:
        e.APALEO_RESERVATION_URL_TEMPLATE ??
        (/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(e.APALEO_API_URL)
          ? `${stripSlash(e.APALEO_API_URL)}/app/{propertyId}/reservations/{reservationId}`
          : 'https://app.apaleo.com/{propertyId}/reservations/{reservationId}'),
    },
    stripe: {
      secretKey: e.STRIPE_SECRET_KEY,
      publishableKey: e.STRIPE_PUBLISHABLE_KEY,
      webhookSecrets: [
        e.STRIPE_WEBHOOK_SECRET,
        ...(e.STRIPE_CONNECT_WEBHOOK_SECRET ? [e.STRIPE_CONNECT_WEBHOOK_SECRET] : []),
      ],
      apiBaseUrl: stripeApiBaseUrl,
      dashboardUrl: stripeApiBaseUrl
        ? null
        : `https://dashboard.stripe.com${e.STRIPE_SECRET_KEY.startsWith('sk_test_') ? '/test' : ''}`,
    },
    llm: {
      anthropic: e.ANTHROPIC_API_KEY ? { apiKey: e.ANTHROPIC_API_KEY, model: e.ANTHROPIC_MODEL } : undefined,
      openai: e.OPENAI_API_KEY ? { apiKey: e.OPENAI_API_KEY, model: e.OPENAI_MODEL } : undefined,
      gemini: e.GEMINI_API_KEY ? { apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL } : undefined,
      perplexity: e.PERPLEXITY_API_KEY
        ? { apiKey: e.PERPLEXITY_API_KEY, model: e.PERPLEXITY_MODEL }
        : undefined,
      extractionModel: e.ANTHROPIC_MODEL,
      embeddings:
        e.EMBEDDINGS_PROVIDER === 'openai'
          ? { provider: 'openai', apiKey: required(e.OPENAI_API_KEY, 'OPENAI_API_KEY') }
          : e.EMBEDDINGS_PROVIDER === 'voyage'
            ? { provider: 'voyage', apiKey: required(e.VOYAGE_API_KEY, 'VOYAGE_API_KEY') }
            : { provider: 'local' },
    },
    business: {
      defaultFeeBps: e.DEFAULT_FEE_BPS,
      holdTtlMinutes: e.HOLD_TTL_MINUTES,
      offerCacheTtlSeconds: e.OFFER_CACHE_TTL_SECONDS,
      offerValidityMinutes: e.OFFER_VALIDITY_MINUTES,
      piiRetentionDays: e.PII_RETENTION_DAYS,
      visibilityRawRetentionDays: e.VISIBILITY_RAW_RETENTION_DAYS,
      visibilityDefaultMonthlyCapCents: e.VISIBILITY_DEFAULT_MONTHLY_CAP_CENTS,
    },
    rateLimits: {
      anonymousPerMinute: e.ANONYMOUS_RATE_LIMIT_PER_MINUTE,
      partnerPerMinute: e.PARTNER_RATE_LIMIT_PER_MINUTE,
    },
    crawler: { allowPrivateNetworks: e.CRAWL_ALLOW_PRIVATE_NETWORKS ?? !isProduction },
    signingSecret: e.SIGNING_SECRET,
    otelEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
  };

  if (isProduction) assertProductionReady(config);
  return config;
}

/** Minimum length of production secrets (32 random bytes encode to 43+ characters; 32 is the floor). */
const MIN_SECRET_LENGTH = 32;

/** A secret that is long enough and not obviously patterned (e.g. a repeated word). */
function weakSecret(value: string): boolean {
  return value.length < MIN_SECRET_LENGTH || new Set(value).size < 16;
}

function isHttps(url: string): boolean {
  return url.startsWith('https://');
}

/**
 * Production refuses to start with development defaults, fakes, local stand-ins or weak secrets.
 * Every problem is reported at once so an operator can fix the environment in one pass.
 */
export function assertProductionReady(config: AppConfig): void {
  const problems: string[] = [];
  const check = (failed: boolean, problem: string) => {
    if (failed) problems.push(problem);
  };

  // Identity: Cognito only. The dev secret signs nothing in production, but a public value must
  // never be configured (and it must not double as another secret).
  check(config.auth.provider !== 'cognito', 'AUTH_PROVIDER must be cognito');
  check(config.auth.devSecret === DEV_SECRETS.authDevSecret, 'AUTH_DEV_SECRET uses the dev default');

  // Token encryption: KMS only; the local master key is never used in production.
  check(config.kms.provider !== 'aws', 'KMS_PROVIDER must be aws (LOCAL_KMS_MASTER_KEY is for development)');

  // Our own secrets.
  check(config.internalApiToken === DEV_SECRETS.internalApiToken, 'INTERNAL_API_TOKEN uses the dev default');
  check(
    config.internalApiToken.length < MIN_SECRET_LENGTH,
    `INTERNAL_API_TOKEN must be at least ${MIN_SECRET_LENGTH} characters`,
  );
  check(config.signingSecret === DEV_SECRETS.signingSecret, 'SIGNING_SECRET uses the dev default');
  check(
    weakSecret(config.signingSecret),
    `SIGNING_SECRET must be at least ${MIN_SECRET_LENGTH} random characters`,
  );
  const shared = [
    config.signingSecret,
    config.auth.devSecret,
    config.internalApiToken,
    config.apaleo.webhookToken,
  ];
  check(
    new Set(shared).size !== shared.length,
    'SIGNING_SECRET, AUTH_DEV_SECRET, INTERNAL_API_TOKEN and APALEO_WEBHOOK_TOKEN must all differ',
  );

  // Stripe: real keys, real API, verified webhooks.
  check(
    config.stripe.secretKey === DEV_SECRETS.stripeSecretKey || !/^(sk|rk)_/.test(config.stripe.secretKey),
    'STRIPE_SECRET_KEY is not set',
  );
  check(
    config.stripe.publishableKey === DEV_SECRETS.stripePublishableKey ||
      !config.stripe.publishableKey.startsWith('pk_'),
    'STRIPE_PUBLISHABLE_KEY is not set',
  );
  check(
    config.stripe.webhookSecrets.some(
      (secret) => secret === DEV_SECRETS.stripeWebhookSecret || !secret.startsWith('whsec_'),
    ),
    'STRIPE_WEBHOOK_SECRET is not set',
  );
  check(!!config.stripe.apiBaseUrl, 'STRIPE_API_BASE_URL must be blank in production');

  // Apaleo: real app credentials over TLS, unguessable webhook path.
  check(config.apaleo.clientId === DEV_SECRETS.apaleoClientId, 'APALEO_CLIENT_ID is not set');
  check(config.apaleo.clientSecret === DEV_SECRETS.apaleoClientSecret, 'APALEO_CLIENT_SECRET is not set');
  check(
    config.apaleo.webhookToken === 'dev-apaleo-webhook-token',
    'APALEO_WEBHOOK_TOKEN uses the dev default',
  );
  check(
    weakSecret(config.apaleo.webhookToken),
    `APALEO_WEBHOOK_TOKEN must be at least ${MIN_SECRET_LENGTH} random characters`,
  );
  check(
    ![config.apaleo.identityUrl, config.apaleo.apiUrl, config.apaleo.webhookUrl].every(isHttps),
    'APALEO_IDENTITY_URL, APALEO_API_URL and APALEO_WEBHOOK_URL must use https',
  );

  // Public URLs and transport.
  check(!isHttps(config.webBaseUrl), 'WEB_BASE_URL must use https');
  check(!isHttps(config.apiBaseUrl), 'API_BASE_URL must use https');
  check(!config.database.ssl, 'DATABASE_SSL must be true');
  check(
    usesDevDatabaseLogin(config.database.url),
    'The database login uses the local development credentials',
  );
  check(!!config.aws.endpointUrl, 'AWS_ENDPOINT_URL must be blank in production (it points at LocalStack)');
  check(
    config.email.provider === 'smtp' && /^smtps?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(config.email.smtpUrl),
    'EMAIL_PROVIDER=smtp points at the local mail catcher',
  );

  // Outbound requests built from hotel input.
  check(config.crawler.allowPrivateNetworks, 'CRAWL_ALLOW_PRIVATE_NETWORKS must be off in production');

  if (problems.length > 0)
    throw new ConfigError(`Production configuration is incomplete: ${problems.join('; ')}`);
}

function usesDevDatabaseLogin(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      decodeURIComponent(parsed.username) === 'lodgent' && decodeURIComponent(parsed.password) === 'lodgent'
    );
  } catch {
    return false;
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new ConfigError(`${name} is required`);
  return value;
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
