import { ApaleoProvider } from '@lodgent/apaleo';
import {
  type Clock,
  type EmbeddingModel,
  type ExtractionModel,
  type IdentityProvider,
  type JobQueue,
  type KeyManagement,
  type Mailer,
  type PmsProvider,
  systemClock,
} from '@lodgent/core';
import { Database } from '@lodgent/db';
import {
  ClaudeExtractionModel,
  KeywordExtractionModel,
  LocalHashEmbedding,
  OpenAIEmbedding,
  VoyageEmbedding,
} from '@lodgent/llm';
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
import { CatalogService } from './services/catalog';
import { InventoryService } from './services/inventory';
import { MemberService } from './services/members';
import { OfferService } from './services/offers';
import { OrganizationService } from './services/organizations';
import { OutboxDispatcher } from './services/outbox-dispatcher';
import { PmsConnectionService } from './services/pms-connections';
import { PmsSyncService } from './services/pms-sync';
import { PmsWebhookService } from './services/pms-webhooks';
import { ProfileService } from './services/profile';
import { PropertyService } from './services/properties';
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
  signer: Signer;
  extraction: ExtractionModel;
  embeddings: EmbeddingModel;
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
  return {
    pmsConnections,
    catalog,
    offers,
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
