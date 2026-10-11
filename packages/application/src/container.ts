import { ApaleoProvider } from '@lodgent/apaleo';
import {
  type Clock,
  type EmbeddingModel,
  type ExtractionModel,
  foldText,
  type IdentityProvider,
  type JobQueue,
  type KeyManagement,
  type Mailer,
  type PaymentProvider,
  type PmsProvider,
  systemClock,
  type VisibilityProvider,
} from '@lodgent/core';
import { Database } from '@lodgent/db';
import {
  AnthropicVisibilityProvider,
  ClaudeExtractionModel,
  GeminiVisibilityProvider,
  KeywordExtractionModel,
  LocalHashEmbedding,
  OpenAIEmbedding,
  OpenAIVisibilityProvider,
  PerplexityVisibilityProvider,
  SimulatedVisibilityProvider,
  VoyageEmbedding,
} from '@lodgent/llm';
import { StripePaymentProvider } from '@lodgent/payments';
import { BRAND } from '@lodgent/shared';
import { ATTRIBUTES } from '@lodgent/taxonomy';
import pino, { type Logger } from 'pino';
import { CognitoIdentityProvider } from './auth/cognito-identity';
import { DevIdentityProvider } from './auth/dev-identity';
import type { AppConfig } from './config';
import { AwsKeyManagement, LocalKeyManagement } from './infra/kms';
import { SesMailer, SmtpMailer } from './infra/mailer';
import { PgJobQueue, SqsJobQueue } from './infra/queue';
import { Signer } from './infra/signing';
import { AccountService } from './services/accounts';
import { AgentService } from './services/agent';
import { AgentClientService } from './services/agent-clients';
import { AgentLog } from './services/agent-log';
import { AuditService } from './services/audit';
import { BillingService } from './services/billing';
import { BookingsService } from './services/bookings';
import { CatalogService } from './services/catalog';
import { CheckoutService } from './services/checkout';
import { InventoryService } from './services/inventory';
import { MemberService } from './services/members';
import { OfferService } from './services/offers';
import { OrganizationService } from './services/organizations';
import { OutboxDispatcher } from './services/outbox-dispatcher';
import { PaymentAccountService } from './services/payment-accounts';
import { PaymentWebhookService } from './services/payment-webhooks';
import { PmsConnectionService } from './services/pms-connections';
import { PmsSyncService } from './services/pms-sync';
import { PmsWebhookService } from './services/pms-webhooks';
import { ProfileService } from './services/profile';
import { PropertyService } from './services/properties';
import { VisibilityService } from './services/visibility';
import { WebsiteImportService } from './services/website-import';

export interface Adapters {
  clock: Clock;
  logger: Logger;
  db: Database;
  identity: IdentityProvider;
  /** Present when AUTH_PROVIDER=dev; issues local session tokens. */
  devIdentity: DevIdentityProvider;
  kms: KeyManagement;
  mailer: Mailer;
  queue: JobQueue;
  pms: PmsProvider;
  payments: PaymentProvider;
  signer: Signer;
  extraction: ExtractionModel;
  embeddings: EmbeddingModel;
  visibilityProviders: VisibilityProvider[];
}

export interface Container extends Adapters {
  config: AppConfig;
  services: ReturnType<typeof createServices>;
  /** One-time startup work (taxonomy sync). Idempotent. */
  init(): Promise<void>;
  close(): Promise<void>;
}

function createServices(config: AppConfig, a: Adapters) {
  const pmsConnections = new PmsConnectionService({
    db: a.db,
    clock: a.clock,
    kms: a.kms,
    provider: a.pms,
    signer: a.signer,
    logger: a.logger,
    redirectUri: config.apaleo.redirectUri,
    webBaseUrl: config.webBaseUrl,
  });
  const catalog = new CatalogService({
    db: a.db,
    clock: a.clock,
    embeddings: a.embeddings,
    webBaseUrl: config.webBaseUrl,
  });
  const offers = new OfferService({
    db: a.db,
    clock: a.clock,
    connections: pmsConnections,
    cacheTtlSeconds: config.business.offerCacheTtlSeconds,
    validityMinutes: config.business.offerValidityMinutes,
  });
  const checkout = new CheckoutService({
    db: a.db,
    clock: a.clock,
    payments: a.payments,
    offers,
    connections: pmsConnections,
    signer: a.signer,
    logger: a.logger,
    webBaseUrl: config.webBaseUrl,
    simulatorUrl: config.stripe.apiBaseUrl ?? null,
    piiRetentionDays: config.business.piiRetentionDays,
  });
  const billing = new BillingService({
    db: a.db,
    clock: a.clock,
    payments: a.payments,
    queue: a.queue,
    logger: a.logger,
  });
  return {
    pmsConnections,
    catalog,
    offers,
    billing,
    bookings: new BookingsService({
      db: a.db,
      clock: a.clock,
      pmsReservationUrlTemplate: config.apaleo.reservationUrlTemplate,
      paymentsDashboardUrl: config.stripe.dashboardUrl,
    }),
    paymentAccounts: new PaymentAccountService({
      db: a.db,
      clock: a.clock,
      payments: a.payments,
      logger: a.logger,
      webBaseUrl: config.webBaseUrl,
      defaultFeeBps: config.business.defaultFeeBps,
    }),
    checkout,
    paymentWebhooks: new PaymentWebhookService({
      db: a.db,
      clock: a.clock,
      payments: a.payments,
      queue: a.queue,
      checkout,
      billing,
      logger: a.logger,
    }),
    visibility: new VisibilityService({
      db: a.db,
      clock: a.clock,
      providers: a.visibilityProviders,
      logger: a.logger,
      webBaseUrl: config.webBaseUrl,
      defaultMonthlyCapCents: config.business.visibilityDefaultMonthlyCapCents,
      rawRetentionDays: config.business.visibilityRawRetentionDays,
    }),
    agent: new AgentService({
      db: a.db,
      clock: a.clock,
      embeddings: a.embeddings,
      offers,
      catalog,
      signer: a.signer,
      log: new AgentLog(a.db, a.logger),
      logger: a.logger,
      webBaseUrl: config.webBaseUrl,
      holdTtlMinutes: config.business.holdTtlMinutes,
      offerCacheTtlSeconds: config.business.offerCacheTtlSeconds,
    }),
    profile: new ProfileService({
      db: a.db,
      clock: a.clock,
      onProfileChanged: CatalogService.afterProfileChange,
    }),
    websiteImport: new WebsiteImportService({
      db: a.db,
      clock: a.clock,
      extraction: a.extraction,
      logger: a.logger,
      allowPrivateNetworks: config.crawler.allowPrivateNetworks,
      crawlDelayMs: config.env === 'production' ? 1000 : 50,
    }),
    pmsSync: new PmsSyncService({
      db: a.db,
      clock: a.clock,
      connections: pmsConnections,
      logger: a.logger,
      webhookEndpoint: `${config.apiBaseUrl}/webhooks/apaleo/${config.apaleo.webhookToken}`,
      defaultFeeBps: config.business.defaultFeeBps,
      onPropertySynced: (orgId, propertyId) =>
        a.queue.enqueue({ type: 'profile.map-pms', payload: { orgId, propertyId } }),
    }),
    pmsWebhooks: new PmsWebhookService({
      db: a.db,
      clock: a.clock,
      logger: a.logger,
      webhookToken: config.apaleo.webhookToken,
    }),
    inventory: new InventoryService(a.db),
    accounts: new AccountService(a.db, a.clock),
    agentClients: new AgentClientService(a.db, a.clock),
    organizations: new OrganizationService(a.db),
    members: new MemberService(a.db, a.clock, config.webBaseUrl),
    properties: new PropertyService(a.db, config.business.defaultFeeBps),
    audit: new AuditService(a.db),
    outbox: new OutboxDispatcher({
      db: a.db,
      mailer: a.mailer,
      queue: a.queue,
      clock: a.clock,
      logger: a.logger,
    }),
  };
}

/**
 * Assistants monitored for AI visibility: every provider with an API key. Without any key (local
 * development, demos) four deterministic simulated assistants stand in, labelled as such.
 */
function visibilityProviders(config: AppConfig, db: Database): VisibilityProvider[] {
  const { anthropic, openai, gemini, perplexity } = config.llm;
  const real: VisibilityProvider[] = [
    ...(anthropic
      ? [new AnthropicVisibilityProvider({ apiKey: anthropic.apiKey, model: anthropic.model })]
      : []),
    ...(openai ? [new OpenAIVisibilityProvider({ apiKey: openai.apiKey, model: openai.model })] : []),
    ...(gemini ? [new GeminiVisibilityProvider({ apiKey: gemini.apiKey, model: gemini.model })] : []),
    ...(perplexity
      ? [new PerplexityVisibilityProvider({ apiKey: perplexity.apiKey, model: perplexity.model })]
      : []),
  ];
  if (real.length > 0 || config.isProduction) return real;
  // Simulated answers mention published hotels located in the city the question names.
  const knownHotels = async (question: string) => {
    const q = foldText(question);
    const hotels = await db.system(({ catalog }) => catalog.publishedProperties());
    return hotels
      .filter((h) => h.city && q.includes(foldText(h.city)))
      .map((h) => ({ name: h.name, website: h.websiteUrl }));
  };
  return (['anthropic', 'openai', 'gemini', 'perplexity'] as const).map(
    (id) => new SimulatedVisibilityProvider(id, knownHotels),
  );
}

/** Composition root: builds every adapter from config. Tests pass `overrides` to swap adapters. */
export function createContainer(
  config: AppConfig,
  overrides: Partial<Adapters> & { name?: string } = {},
): Container {
  const logger =
    overrides.logger ??
    pino({
      name: `${BRAND.slug}-${overrides.name ?? 'app'}`,
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          '*.password',
          '*.token',
        ],
        censor: '[redacted]',
      },
    });
  const db =
    overrides.db ??
    new Database({
      connectionString: config.database.url,
      ssl: config.database.ssl,
      max: config.database.poolMax,
      applicationName: `${BRAND.slug}-${overrides.name ?? 'app'}`,
    });
  const devIdentity = overrides.devIdentity ?? new DevIdentityProvider(config.auth.devSecret);
  const identity =
    overrides.identity ??
    (config.auth.provider === 'cognito'
      ? new CognitoIdentityProvider({ userPoolId: config.auth.userPoolId, clientId: config.auth.clientId })
      : devIdentity);
  const kms =
    overrides.kms ??
    (config.kms.provider === 'aws'
      ? AwsKeyManagement.create({
          keyId: config.kms.keyId,
          region: config.aws.region,
          endpoint: config.aws.endpointUrl,
        })
      : new LocalKeyManagement(config.kms.masterKey));
  const mailer =
    overrides.mailer ??
    (config.email.provider === 'ses'
      ? SesMailer.create({
          region: config.aws.region,
          endpoint: config.aws.endpointUrl,
          from: config.email.from,
        })
      : new SmtpMailer(config.email.smtpUrl, config.email.from));
  const queue =
    overrides.queue ??
    (config.queue.provider === 'sqs'
      ? SqsJobQueue.create({
          queueUrl: config.queue.queueUrl,
          region: config.aws.region,
          endpoint: config.aws.endpointUrl,
        })
      : new PgJobQueue(db));

  const pms =
    overrides.pms ??
    new ApaleoProvider({
      clientId: config.apaleo.clientId,
      clientSecret: config.apaleo.clientSecret,
      identityUrl: config.apaleo.identityUrl,
      apiUrl: config.apaleo.apiUrl,
      webhookUrl: config.apaleo.webhookUrl,
      scopes: config.apaleo.scopes ?? undefined,
      channelCode: config.apaleo.channelCode,
    });

  const adapters: Adapters = {
    clock: overrides.clock ?? systemClock,
    logger,
    db,
    identity,
    devIdentity,
    kms,
    mailer,
    queue,
    pms,
    payments:
      overrides.payments ??
      new StripePaymentProvider({
        secretKey: config.stripe.secretKey,
        publishableKey: config.stripe.publishableKey,
        webhookSecrets: config.stripe.webhookSecrets,
        apiBaseUrl: config.stripe.apiBaseUrl,
        simulated: !!config.stripe.apiBaseUrl,
      }),
    signer: overrides.signer ?? new Signer(config.signingSecret),
    extraction:
      overrides.extraction ??
      (config.llm.anthropic
        ? new ClaudeExtractionModel({
            apiKey: config.llm.anthropic.apiKey,
            model: config.llm.extractionModel,
          })
        : new KeywordExtractionModel(new Map(ATTRIBUTES.map((a) => [a.code, a.synonyms])))),
    embeddings:
      overrides.embeddings ??
      (config.llm.embeddings.provider === 'openai'
        ? new OpenAIEmbedding(config.llm.embeddings.apiKey)
        : config.llm.embeddings.provider === 'voyage'
          ? new VoyageEmbedding(config.llm.embeddings.apiKey)
          : new LocalHashEmbedding()),
    visibilityProviders: overrides.visibilityProviders ?? visibilityProviders(config, db),
  };

  return {
    ...adapters,
    config,
    services: createServices(config, adapters),
    async init() {
      await db.system(({ taxonomy }) =>
        taxonomy.upsertDefinitions(
          ATTRIBUTES.map((a) => ({
            code: a.code,
            label: a.label,
            category: a.category,
            appliesTo: a.appliesTo,
            importance: a.importance,
            valueType: a.valueType,
            enumValues: a.enumValues,
          })),
        ),
      );
    },
    async close() {
      await db.close();
    },
  };
}
