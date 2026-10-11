import { BRAND } from '@lodgent/shared';
import { Annotations, Aws, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config';
import { DB_PORT, type NetworkStack } from './network-stack';

/**
 * Keys of the app secret `<slug>/<env>/app` (JSON) that the tasks reference as ECS secrets. The
 * operator fills in the values after the data stack is deployed. ECS refuses to start a task whose
 * secret lacks a referenced key: to add a key, add it to the existing secret first (runbook), then
 * here. Do not add it to APP_SECRET_TEMPLATE_KEYS.
 */
export const APP_SECRET_KEYS = [
  'INTERNAL_API_TOKEN',
  'SIGNING_SECRET',
  'AUTH_DEV_SECRET',
  'APALEO_CLIENT_ID',
  'APALEO_CLIENT_SECRET',
  'APALEO_WEBHOOK_TOKEN',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_CONNECT_WEBHOOK_SECRET',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'PERPLEXITY_API_KEY',
  'VOYAGE_API_KEY',
  'COGNITO_CLIENT_SECRET',
] as const;
export type AppSecretKey = (typeof APP_SECRET_KEYS)[number];

/**
 * The JSON keys CloudFormation writes when it creates the app secret: SIGNING_SECRET is generated
 * (64 random alphanumerics), the others are empty strings. FROZEN: CloudFormation generates a new
 * value for the whole secret whenever GenerateSecretString changes, which would wipe the operator's
 * values. That is why this is a separate list from APP_SECRET_KEYS.
 */
export const APP_SECRET_TEMPLATE_KEYS: readonly string[] = [
  'INTERNAL_API_TOKEN',
  'SIGNING_SECRET',
  'AUTH_DEV_SECRET',
  'APALEO_CLIENT_ID',
  'APALEO_CLIENT_SECRET',
  'APALEO_WEBHOOK_TOKEN',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_CONNECT_WEBHOOK_SECRET',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'PERPLEXITY_API_KEY',
  'VOYAGE_API_KEY',
  'COGNITO_CLIENT_SECRET',
];
const GENERATED_APP_SECRET_KEY = 'SIGNING_SECRET';

export interface DataStackProps extends StackProps {
  config: EnvConfig;
  network: NetworkStack;
}

export interface EmailSettings {
  /** RFC 5322 From header for EMAIL_FROM. */
  from: string;
  /** SES resources the task role may send through (identity ARNs and the configuration set). */
  sendResources: string[];
}

/**
 * Stateful resources: encryption keys, PostgreSQL, the app secret, the jobs queue, container
 * registries, the Cognito user pool and the SES identity. Deployed before images are pushed, so the
 * pipeline can push to the registries, and before the services, so the operator can fill the app
 * secret first. With `protectData` everything here is retained on stack deletion.
 */
export class DataStack extends Stack {
  readonly dataKey: kms.Key;
  readonly appKey: kms.Key;
  readonly database: rds.DatabaseInstance;
  readonly databaseSecret: secretsmanager.ISecret;
  readonly appSecret: secretsmanager.Secret;
  readonly jobsQueue: sqs.Queue;
  readonly jobsDeadLetterQueue: sqs.Queue;
  readonly repositories: Record<'api' | 'worker' | 'web', ecr.Repository>;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  /** Managed-login host name (no scheme), as the web app expects in COGNITO_DOMAIN. */
  readonly cognitoDomain: string;
  readonly email: EmailSettings;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { config, network } = props;
    const { names } = config;
    const retain = config.protectData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const { exportName } = names;

    // ---- Keys --------------------------------------------------------------------------------
    this.dataKey = new kms.Key(this, 'DataKey', {
      alias: `alias/${names.prefix}/data`,
      description: `${names.prefix}: RDS storage, Performance Insights and Secrets Manager secrets`,
      enableKeyRotation: true,
      removalPolicy: retain,
    });
    this.appKey = new kms.Key(this, 'AppKey', {
      alias: `alias/${names.prefix}/app`,
      description: `${names.prefix}: envelope encryption of integration tokens by the app (KMS_KEY_ID)`,
      enableKeyRotation: true,
      removalPolicy: retain,
    });

    // ---- App secret ------------------------------------------------------------------------------
    const template = Object.fromEntries(
      APP_SECRET_TEMPLATE_KEYS.filter((key) => key !== GENERATED_APP_SECRET_KEY).map((key) => [key, '']),
    );
    this.appSecret = new secretsmanager.Secret(this, 'AppSecret', {
      secretName: names.appSecret,
      description: `${BRAND.name} ${config.envName} application secrets. Fill in the empty values after the first deploy (docs/runbooks/aws-infrastructure.md).`,
      encryptionKey: this.dataKey,
      removalPolicy: retain,
      generateSecretString: {
        secretStringTemplate: JSON.stringify(template),
        generateStringKey: GENERATED_APP_SECRET_KEY,
        passwordLength: 64,
        excludePunctuation: true,
      },
    });

    // ---- PostgreSQL ----------------------------------------------------------------------------
    const engine = rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 });
    const parameterGroup = new rds.ParameterGroup(this, 'DatabaseParameters', {
      engine,
      description: `${names.prefix} PostgreSQL 16`,
      parameters: {
        'rds.force_ssl': '1',
        log_min_duration_statement: '1000',
        // Slow-statement logs keep the SQL text but not the bind parameters (guest PII, tokens).
        // Error logs omit them by default (log_parameter_max_length_on_error = 0).
        log_parameter_max_length: '0',
        log_lock_waits: '1',
        idle_in_transaction_session_timeout: '300000',
      },
    });
    // Master credentials, generated by Secrets Manager; retained with the database in prod.
    const databaseCredentials = new rds.DatabaseSecret(this, 'DatabaseCredentials', {
      username: names.databaseUser,
      secretName: `${config.slug}/${config.envName}/database`,
      encryptionKey: this.dataKey,
    });
    databaseCredentials.applyRemovalPolicy(retain);
    // Log groups owned by the stack (with retention) instead of the custom-resource retention hook.
    const dbLogGroups = ['postgresql', 'upgrade'].map(
      (type) =>
        new logs.LogGroup(this, `DatabaseLogs${type}`, {
          logGroupName: `/aws/rds/instance/${names.dbInstanceIdentifier}/${type}`,
          retention: config.logRetentionDays,
          removalPolicy: retain,
        }),
    );
    this.database = new rds.DatabaseInstance(this, 'Database', {
      instanceIdentifier: names.dbInstanceIdentifier,
      engine,
      instanceType: new ec2.InstanceType(config.dbInstanceClass),
      vpc: network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [network.securityGroups.database],
      publiclyAccessible: false,
      port: DB_PORT,
      databaseName: names.databaseName,
      credentials: rds.Credentials.fromSecret(databaseCredentials),
      parameterGroup,
      storageType: rds.StorageType.GP3,
      allocatedStorage: config.dbAllocatedStorageGiB,
      maxAllocatedStorage: config.dbMaxAllocatedStorageGiB,
      storageEncrypted: true,
      storageEncryptionKey: this.dataKey,
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
      multiAz: config.dbMultiAz,
      backupRetention: Duration.days(config.dbBackupRetentionDays),
      preferredBackupWindow: '01:00-02:00',
      preferredMaintenanceWindow: 'sun:02:15-sun:02:45',
      deleteAutomatedBackups: !config.protectData,
      copyTagsToSnapshot: true,
      deletionProtection: config.protectData,
      removalPolicy: config.protectData ? RemovalPolicy.RETAIN : RemovalPolicy.SNAPSHOT,
      autoMinorVersionUpgrade: true,
      allowMajorVersionUpgrade: false,
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      performanceInsightEncryptionKey: this.dataKey,
      monitoringInterval: config.protectData ? Duration.seconds(60) : undefined,
      cloudwatchLogsExports: ['postgresql', 'upgrade'],
    });
    for (const group of dbLogGroups) this.database.node.addDependency(group);
    this.databaseSecret = this.database.secret!;

    // ---- Jobs queue ------------------------------------------------------------------------------
    // SQS-managed encryption: free, no KMS calls on every send/receive; messages carry job types and
    // ids only (no guest PII).
    this.jobsDeadLetterQueue = new sqs.Queue(this, 'JobsDeadLetterQueue', {
      queueName: `${names.prefix}-jobs-dlq`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });
    this.jobsQueue = new sqs.Queue(this, 'JobsQueue', {
      queueName: `${names.prefix}-jobs`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      // Longest job (website crawl, visibility run) must finish before the message reappears.
      visibilityTimeout: Duration.minutes(15),
      receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: this.jobsDeadLetterQueue, maxReceiveCount: 5 },
    });

    // ---- Container registries -------------------------------------------------------------------
    const repository = (service: 'api' | 'worker' | 'web') =>
      new ecr.Repository(this, `${service[0]!.toUpperCase()}${service.slice(1)}Repository`, {
        repositoryName: names.repository(service),
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        encryption: ecr.RepositoryEncryption.AES_256,
        removalPolicy: retain,
        emptyOnDelete: !config.protectData,
        lifecycleRules: [
          {
            rulePriority: 1,
            description: 'Expire untagged images after 7 days',
            tagStatus: ecr.TagStatus.UNTAGGED,
            maxImageAge: Duration.days(7),
          },
          {
            rulePriority: 2,
            description: 'Keep the most recent images (rollback targets)',
            tagStatus: ecr.TagStatus.ANY,
            maxImageCount: config.protectData ? 100 : 30,
          },
        ],
      });
    this.repositories = { api: repository('api'), worker: repository('worker'), web: repository('web') };

    // ---- Hotel-user sign-in (Cognito) --------------------------------------------------------
    const threat = config.cognitoThreatProtection;
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: names.prefix,
      // Essentials is the default plan for new pools (no charge below its free tier). Threat
      // protection (formerly "advanced security") needs Plus, billed per MAU, so it is opt-in.
      featurePlan: threat === 'off' ? cognito.FeaturePlan.ESSENTIALS : cognito.FeaturePlan.PLUS,
      standardThreatProtectionMode:
        threat === 'enforced'
          ? cognito.StandardThreatProtectionMode.FULL_FUNCTION
          : threat === 'audit'
            ? cognito.StandardThreatProtectionMode.AUDIT_ONLY
            : undefined,
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      keepOriginal: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
        tempPasswordValidity: Duration.days(3),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: config.protectData,
      removalPolicy: retain,
    });

    const webOrigins =
      config.edge.kind === 'domain' ? [`https://${config.edge.webHostname}`] : ([] as string[]);
    // Cognito accepts plain-HTTP callbacks only for localhost: dev also allows a local web app.
    if (config.envName === 'dev' || webOrigins.length === 0) webOrigins.push('http://localhost:3000');
    this.userPoolClient = this.userPool.addClient('WebClient', {
      userPoolClientName: `${names.prefix}-web`,
      generateSecret: true,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: webOrigins.map((origin) => `${origin}/auth/callback`),
        logoutUrls: webOrigins.map((origin) => `${origin}/login`),
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });
    const domainPrefix = config.cognitoDomainPrefix ?? `${names.prefix}-${Aws.ACCOUNT_ID}`;
    this.userPool.addDomain('ManagedLoginDomain', {
      cognitoDomain: { domainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.CLASSIC_HOSTED_UI,
    });
    this.cognitoDomain = `${domainPrefix}.auth.${config.region}.amazoncognito.com`;

    // ---- Email (SES) -------------------------------------------------------------------------
    this.email = this.createEmail(config);

    // ---- Outputs -----------------------------------------------------------------------------
    for (const [service, repo] of Object.entries(this.repositories)) {
      const name = `${service[0]!.toUpperCase()}${service.slice(1)}RepositoryUri`;
      new CfnOutput(this, name, {
        description: `ECR repository for the ${service} image (tag = git SHA)`,
        value: repo.repositoryUri,
        exportName: exportName(name),
      });
    }
    new CfnOutput(this, 'AppSecretArn', {
      description: `App secret (${names.appSecret}); fill in the values before deploying the services`,
      value: this.appSecret.secretArn,
      exportName: exportName('AppSecretArn'),
    });
    new CfnOutput(this, 'DatabaseEndpoint', {
      value: this.database.dbInstanceEndpointAddress,
      exportName: exportName('DatabaseEndpoint'),
    });
    new CfnOutput(this, 'DatabaseSecretArn', {
      description: 'RDS master credentials (username/password JSON)',
      value: this.databaseSecret.secretArn,
      exportName: exportName('DatabaseSecretArn'),
    });
    new CfnOutput(this, 'JobsQueueUrl', {
      value: this.jobsQueue.queueUrl,
      exportName: exportName('JobsQueueUrl'),
    });
    new CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: exportName('UserPoolId'),
    });
    new CfnOutput(this, 'UserPoolClientId', {
      description: 'Web app client; its secret goes into COGNITO_CLIENT_SECRET of the app secret',
      value: this.userPoolClient.userPoolClientId,
      exportName: exportName('UserPoolClientId'),
    });
    new CfnOutput(this, 'CognitoDomain', {
      value: this.cognitoDomain,
      exportName: exportName('CognitoDomain'),
    });
    new CfnOutput(this, 'AppKmsKeyArn', {
      value: this.appKey.keyArn,
      exportName: exportName('AppKmsKeyArn'),
    });
  }

  private createEmail(config: EnvConfig): EmailSettings {
    const { edge, names } = config;
    if (edge.kind !== 'domain') {
      const from = config.emailFrom ?? BRAND.defaultEmailFrom;
      Annotations.of(this).addInfo(
        `${config.envName}: no domainName, so no SES identity is created; email sending fails until one is configured.`,
      );
      return {
        from,
        sendResources: [this.formatArn({ service: 'ses', resource: 'identity', resourceName: '*' })],
      };
    }

    const configurationSet = new ses.ConfigurationSet(this, 'EmailConfigurationSet', {
      configurationSetName: names.prefix,
      reputationMetrics: true,
      sendingEnabled: true,
      suppressionReasons: ses.SuppressionReasons.BOUNCES_AND_COMPLAINTS,
      tlsPolicy: ses.ConfigurationSetTlsPolicy.REQUIRE,
    });
    const zone = edge.hostedZone
      ? route53.PublicHostedZone.fromPublicHostedZoneAttributes(this, 'HostedZone', {
          hostedZoneId: edge.hostedZone.id,
          zoneName: edge.hostedZone.name,
        })
      : undefined;
    const identity = new ses.EmailIdentity(this, 'EmailIdentity', {
      // With a hosted zone the DKIM and MAIL FROM records are created; otherwise see the outputs.
      identity: zone ? new DomainInHostedZone(edge.domainName, zone) : ses.Identity.domain(edge.domainName),
      configurationSet,
      mailFromDomain: `mail.${edge.domainName}`,
    });
    if (!zone) {
      identity.dkimRecords.forEach((record, index) => {
        new CfnOutput(this, `EmailDkimRecord${index + 1}`, {
          description: 'Add this CNAME to the domain to verify the SES identity (DKIM)',
          value: `${record.name} CNAME ${record.value}`,
        });
      });
    }

    const from = config.emailFrom ?? `${BRAND.name} Bookings <bookings@${edge.domainName}>`;
    const address = /<([^>]+)>\s*$/.exec(from)?.[1] ?? from;
    if (!address.endsWith(`@${edge.domainName}`) && !address.endsWith(`.${edge.domainName}`)) {
      Annotations.of(this).addWarning(
        `${config.envName}: emailFrom ${address} is outside ${edge.domainName}; SES rejects it unless that address or domain is verified too.`,
      );
    }
    return {
      from,
      sendResources: [
        // Sandbox accounts also check the recipient identity, hence the wildcard within this account.
        this.formatArn({ service: 'ses', resource: 'identity', resourceName: '*' }),
        this.formatArn({
          service: 'ses',
          resource: 'configuration-set',
          resourceName: configurationSet.configurationSetName,
        }),
      ],
    };
  }
}

/** A domain identity whose DNS records go into a (parent) public hosted zone. */
class DomainInHostedZone extends ses.Identity {
  constructor(
    readonly value: string,
    readonly hostedZone: route53.IPublicHostedZone,
  ) {
    super();
  }
}
