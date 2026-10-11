import {
  type Clock,
  type IdentityProvider,
  type JobQueue,
  type KeyManagement,
  type Mailer,
  systemClock,
} from '@lodgent/core';
import { Database } from '@lodgent/db';
import { BRAND } from '@lodgent/shared';
import pino, { type Logger } from 'pino';
import { CognitoIdentityProvider } from './auth/cognito-identity';
import { DevIdentityProvider } from './auth/dev-identity';
import type { AppConfig } from './config';
import { AwsKeyManagement, LocalKeyManagement } from './infra/kms';
import { SesMailer, SmtpMailer } from './infra/mailer';
import { PgJobQueue, SqsJobQueue } from './infra/queue';
import { AccountService } from './services/accounts';
import { AgentClientService } from './services/agent-clients';
import { AuditService } from './services/audit';
import { MemberService } from './services/members';
import { OrganizationService } from './services/organizations';
import { OutboxDispatcher } from './services/outbox-dispatcher';
import { PropertyService } from './services/properties';

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
}

export interface Container extends Adapters {
  config: AppConfig;
  services: ReturnType<typeof createServices>;
  close(): Promise<void>;
}

function createServices(config: AppConfig, a: Adapters) {
  return {
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

  const adapters: Adapters = {
    clock: overrides.clock ?? systemClock,
    logger,
    db,
    identity,
    devIdentity,
    kms,
    mailer,
    queue,
  };

  return {
    ...adapters,
    config,
    services: createServices(config, adapters),
    async close() {
      await db.close();
    },
  };
}
