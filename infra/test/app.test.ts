import { SCHEDULES } from '@lodgent/shared';
import { Match } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { API_PATH_PATTERNS } from '../lib/edge';
import { MIGRATE_COMMAND } from '../lib/platform-stack';
import { ADOT_COLLECTOR_IMAGE, OTLP_ENDPOINT } from '../lib/runtime';
import { container, environment, only, resources, type Synthesized, synth } from './helpers';

/** What SqsJobConsumer (packages/application/src/jobs/runner.ts) accepts. */
const SqsJobMessage = z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()) });

let app: Synthesized;
beforeAll(() => {
  app = synth();
});

describe('stacks', () => {
  it('defines four stacks per environment plus the GitHub deploy stack', () => {
    const ids = [
      ...Object.values(app.stacks.environments).flatMap((e) =>
        [e.network, e.data, e.platform, e.services].map((s) => s.stackName),
      ),
      app.stacks.github.stackName,
    ];
    expect(ids).toEqual([
      'lodgent-dev-network',
      'lodgent-dev-data',
      'lodgent-dev-platform',
      'lodgent-dev-services',
      'lodgent-prod-network',
      'lodgent-prod-data',
      'lodgent-prod-platform',
      'lodgent-prod-services',
      'lodgent-github-deploy',
    ]);
    for (const env of Object.values(app.stacks.environments)) {
      app.template(env.services); // dependencies are known once the app has been synthesized
      expect(env.services.dependencies.map((s) => s.stackName).sort()).toEqual([
        `lodgent-${env.config.envName}-data`,
        `lodgent-${env.config.envName}-network`,
        `lodgent-${env.config.envName}-platform`,
      ]);
      expect(env.network.tags.tagValues()).toEqual({ app: 'lodgent', env: env.config.envName });
      expect(env.network.region).toBe('eu-central-1');
    }
    expect(app.env('prod').data.terminationProtection).toBe(true);
    expect(app.env('dev').data.terminationProtection).toBe(false);
  });

  it('synthesizes a single environment when the env context is set', () => {
    const devOnly = synth({ env: 'dev' });
    expect(Object.keys(devOnly.stacks.environments)).toEqual(['dev']);
    expect(devOnly.stacks.github.stackName).toBe('lodgent-github-deploy');
    expect(() => synth({ env: 'staging' })).toThrow(/env "staging"/);
  });

  it('deploys an environment to the region from context', () => {
    const regional = synth({ region: 'eu-west-1', 'prod.region': 'us-east-1' });
    expect(regional.env('dev').services.region).toBe('eu-west-1');
    expect(regional.env('prod').services.region).toBe('us-east-1');
    expect(regional.stacks.github.region).toBe('eu-west-1');
    expect(() => synth({ 'dev.region': 'mars' })).toThrow(/not an AWS region/);
  });

  it('exports the outputs the deploy pipeline reads under stable names', () => {
    const exportsOf = (t: ReturnType<Synthesized['template']>) =>
      Object.values(t.toJSON().Outputs as Record<string, { Export?: { Name: string } }>)
        .map((o) => o.Export?.Name)
        .filter((name): name is string => !!name && !name.includes(':'));
    const prod = app.env('prod');
    const names = [prod.network, prod.data, prod.platform, prod.services].flatMap((s) =>
      exportsOf(app.template(s)),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'lodgent-prod-AppSubnetIds',
        'lodgent-prod-AppSecurityGroupId',
        'lodgent-prod-ApiRepositoryUri',
        'lodgent-prod-WorkerRepositoryUri',
        'lodgent-prod-WebRepositoryUri',
        'lodgent-prod-AppSecretArn',
        'lodgent-prod-ClusterName',
        'lodgent-prod-MigrateTaskDefinitionArn',
        'lodgent-prod-MigrateLogGroupName',
        'lodgent-prod-LoadBalancerDnsName',
        'lodgent-prod-WebUrl',
        'lodgent-prod-ApiUrl',
        'lodgent-prod-ApiServiceName',
        'lodgent-prod-WorkerServiceName',
        'lodgent-prod-WebServiceName',
      ]),
    );
  });
});

describe('container registries', () => {
  it('creates immutable, scanned repositories named <slug>-<env>-<service>', () => {
    for (const env of ['dev', 'prod'] as const) {
      const data = app.template(app.env(env).data);
      const repos = Object.values(resources(data, 'AWS::ECR::Repository'));
      expect(repos.map((r) => r.Properties.RepositoryName).sort()).toEqual([
        `lodgent-${env}-api`,
        `lodgent-${env}-web`,
        `lodgent-${env}-worker`,
      ]);
      for (const repo of repos) {
        expect(repo.Properties).toMatchObject({
          ImageTagMutability: 'IMMUTABLE',
          ImageScanningConfiguration: { ScanOnPush: true },
        });
        expect(repo.Properties.LifecyclePolicy).toBeDefined();
      }
    }
  });

  it('deploys the image tag from context (default "latest")', () => {
    const imageOf = (s: Synthesized, name: string) =>
      JSON.stringify(container(s.template(s.env('dev').services), name).Image);
    expect(imageOf(app, 'api')).toContain(':latest');
    const tagged = synth({ imageTag: '0123abc' });
    for (const name of ['api', 'worker', 'web']) expect(imageOf(tagged, name)).toContain(':0123abc');
    expect(JSON.stringify(container(tagged.template(tagged.env('dev').platform), 'migrate').Image)).toContain(
      'lodgent-dev-data:ExportsOutputRefApiRepository',
    );
  });
});

describe('schedules', () => {
  for (const env of ['dev', 'prod'] as const) {
    it(`${env}: one EventBridge schedule per SCHEDULES entry, sending the job message to the jobs queue`, () => {
      const platform = app.template(app.env(env).platform);
      const schedules = Object.values(resources(platform, 'AWS::Scheduler::Schedule'));
      expect(schedules).toHaveLength(SCHEDULES.length);
      for (const definition of SCHEDULES) {
        const schedule = schedules.find((s) => s.Properties.Name === definition.name);
        expect(schedule, definition.name).toBeDefined();
        const props = schedule!.Properties as {
          GroupName: string;
          ScheduleExpression: string;
          ScheduleExpressionTimezone: string;
          State: string;
          Target: { Arn: unknown; Input: string; RoleArn: unknown; DeadLetterConfig: { Arn: unknown } };
        };
        expect(props.GroupName).toBe(`lodgent-${env}`);
        expect(props.ScheduleExpression).toBe(definition.expression);
        expect(props.ScheduleExpressionTimezone).toBe('Etc/UTC');
        expect(props.State).toBe('ENABLED');
        expect(JSON.stringify(props.Target.Arn)).toMatch(
          new RegExp(`lodgent-${env}-data:.*JobsQueue[0-9A-F]+Arn`),
        );
        expect(JSON.stringify(props.Target.DeadLetterConfig.Arn)).toContain('JobsDeadLetterQueue');

        const message = SqsJobMessage.parse(JSON.parse(props.Target.Input));
        expect(message).toEqual(definition.job);
        expect(JSON.parse(props.Target.Input).dedupeKey).toBe(
          `schedule:${definition.name}:<aws.scheduler.scheduled-time>`,
        );
      }
    });
  }

  it('lets the scheduler role send to the jobs queues only, for this account', () => {
    const platform = app.template(app.env('prod').platform);
    const role = Object.entries(resources(platform, 'AWS::IAM::Role')).find(([id]) =>
      id.startsWith('SchedulerRole'),
    )!;
    expect(JSON.stringify(role[1].Properties.AssumeRolePolicyDocument)).toContain('aws:SourceAccount');
    const policy = Object.values(resources(platform, 'AWS::IAM::Policy')).find((p) =>
      JSON.stringify(p.Properties.Roles).includes(role[0]),
    )!;
    expect(policy.Properties.PolicyDocument).toEqual({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'sqs:SendMessage', Resource: expect.any(Array) }],
    });
  });
});

describe('runtime configuration contract', () => {
  it('api and worker get the AWS providers, database parts and telemetry endpoint', () => {
    const services = app.template(app.env('prod').services);
    for (const [name, otelName] of [
      ['api', 'lodgent-api'],
      ['worker', 'lodgent-worker'],
    ] as const) {
      const env = environment(container(services, name));
      expect(env).toMatchObject({
        APP_ENV: 'production',
        API_PORT: '4000',
        AUTH_PROVIDER: 'cognito',
        AWS_REGION: 'eu-central-1',
        KMS_PROVIDER: 'aws',
        QUEUE_PROVIDER: 'sqs',
        EMAIL_PROVIDER: 'ses',
        DATABASE_SSL: 'true',
        DATABASE_NAME: 'lodgent',
        OTEL_EXPORTER_OTLP_ENDPOINT: OTLP_ENDPOINT,
        OTEL_SERVICE_NAME: otelName,
        APALEO_API_URL: 'https://api.apaleo.com',
      });
      for (const key of [
        'LOG_LEVEL',
        'WEB_BASE_URL',
        'API_BASE_URL',
        'COGNITO_USER_POOL_ID',
        'COGNITO_CLIENT_ID',
        'COGNITO_DOMAIN',
        'KMS_KEY_ID',
        'SQS_QUEUE_URL',
        'EMAIL_FROM',
        'DATABASE_HOST',
        'DATABASE_PORT',
      ]) {
        expect(env[key], `${name} ${key}`).toBeDefined();
      }
      expect(env).not.toHaveProperty('DATABASE_URL');
    }
  });

  it('web gets its port, the internal API URL and the Cognito settings', () => {
    const services = app.template(app.env('prod').services);
    const web = container(services, 'web');
    expect(environment(web)).toMatchObject({
      APP_ENV: 'production',
      PORT: '3000',
      HOSTNAME: '0.0.0.0',
      API_INTERNAL_URL: 'http://api.lodgent-prod.internal:4000',
      AUTH_PROVIDER: 'cognito',
      OTEL_SERVICE_NAME: 'lodgent-web',
    });
    expect(environment(web).COGNITO_DOMAIN).toEqual({
      'Fn::Join': ['', ['lodgent-prod-', { Ref: 'AWS::AccountId' }, '.auth.eu-central-1.amazoncognito.com']],
    });
    services.hasResourceProperties('AWS::ServiceDiscovery::Service', {
      Name: 'api',
      DnsConfig: Match.objectLike({ DnsRecords: [{ TTL: 10, Type: 'A' }] }),
    });
  });

  it('adds a non-essential ADOT collector sidecar to the api and worker, not the web', () => {
    const services = app.template(app.env('dev').services);
    for (const task of Object.values(resources(services, 'AWS::ECS::TaskDefinition'))) {
      const defs = task.Properties.ContainerDefinitions as {
        Name: string;
        Image: string;
        Essential: boolean;
        Environment?: { Name: string; Value: string }[];
        DependsOn?: unknown[];
      }[];
      const collector = defs.find((c) => c.Name === 'otel-collector');
      const family = task.Properties.Family as string;
      if (family === 'lodgent-dev-web') {
        expect(collector).toBeUndefined();
        continue;
      }
      expect(collector, family).toBeDefined();
      expect(collector!.Image).toBe(ADOT_COLLECTOR_IMAGE);
      expect(collector!.Essential).toBe(false);
      const config = collector!.Environment!.find((e) => e.Name === 'AOT_CONFIG_CONTENT')!.Value;
      expect(config).toContain('endpoint: 127.0.0.1:4318');
      expect(config).toContain('awsxray:');
      const app = defs.find((c) => c.Name !== 'otel-collector')!;
      expect(app.DependsOn).toEqual([{ ContainerName: 'otel-collector', Condition: 'START' }]);
    }
  });

  it('defines the migration task on the api image with only database settings', () => {
    const platform = app.template(app.env('prod').platform);
    const task = only(resources(platform, 'AWS::ECS::TaskDefinition'));
    expect(task.Properties.Family).toBe('lodgent-prod-migrate');
    const migrate = container(platform, 'migrate');
    expect(migrate.Command).toEqual(MIGRATE_COMMAND);
    expect(Object.keys(environment(migrate)).sort()).toEqual([
      'APP_ENV',
      'DATABASE_HOST',
      'DATABASE_NAME',
      'DATABASE_PORT',
      'DATABASE_SSL',
      'LOG_LEVEL',
    ]);
    platform.hasResourceProperties('AWS::IAM::Role', { RoleName: 'lodgent-prod-migrate-execution' });
    platform.hasResourceProperties('AWS::IAM::Role', { RoleName: 'lodgent-prod-migrate-task' });
  });

  it('autoscales api and web on CPU and requests, the worker on queue depth', () => {
    const services = app.template(app.env('prod').services);
    const targets = Object.values(resources(services, 'AWS::ApplicationAutoScaling::ScalableTarget')).map(
      (t) => [t.Properties.MinCapacity, t.Properties.MaxCapacity],
    );
    expect(targets.sort()).toEqual([
      [1, 4],
      [2, 4],
      [2, 6],
    ]);
    const policies = Object.values(resources(services, 'AWS::ApplicationAutoScaling::ScalingPolicy'));
    const metrics = policies.map(
      (p) =>
        (
          p.Properties.TargetTrackingScalingPolicyConfiguration as
            | { PredefinedMetricSpecification?: { PredefinedMetricType: string } }
            | undefined
        )?.PredefinedMetricSpecification?.PredefinedMetricType ?? p.Properties.PolicyType,
    );
    expect(metrics.filter((m) => m === 'ECSServiceAverageCPUUtilization')).toHaveLength(3);
    expect(metrics.filter((m) => m === 'ALBRequestCountPerTarget')).toHaveLength(2);
    expect(metrics.filter((m) => m === 'StepScaling').length).toBeGreaterThanOrEqual(2);
  });
});

describe('alarms', () => {
  it('alarm on 5xx rate, latency, unhealthy hosts, database, dead letters and queue age', () => {
    const platform = app.template(app.env('prod').platform);
    const names = Object.values(resources(platform, 'AWS::CloudWatch::Alarm')).map(
      (a) => a.Properties.AlarmName,
    );
    expect(names.sort()).toEqual(
      [
        'lodgent-prod-alb-5xx-rate',
        'lodgent-prod-api-p95-latency',
        'lodgent-prod-api-unhealthy-hosts',
        'lodgent-prod-web-p95-latency',
        'lodgent-prod-web-unhealthy-hosts',
        'lodgent-prod-db-cpu',
        'lodgent-prod-db-free-storage',
        'lodgent-prod-db-connections',
        'lodgent-prod-jobs-dlq-not-empty',
        'lodgent-prod-jobs-oldest-message-age',
      ].sort(),
    );
    platform.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'lodgent-prod-jobs-dlq-not-empty',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
      AlarmActions: [{ Ref: Match.stringLikeRegexp('^AlarmTopic') }],
    });
    const services = app.template(app.env('prod').services);
    const serviceAlarms = Object.values(resources(services, 'AWS::CloudWatch::Alarm'))
      .map((a) => a.Properties.AlarmName as string | undefined)
      .filter(Boolean);
    // CPU, memory and running tasks per service (the unnamed ones belong to step scaling).
    expect(serviceAlarms).toHaveLength(9);
    services.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
  });

  it('subscribes the alarm email from context', () => {
    const withEmail = synth({ 'prod.alarmEmail': 'ops@example.com' });
    withEmail.template(withEmail.env('prod').platform).hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'ops@example.com',
    });
    app.template(app.env('prod').platform).resourceCountIs('AWS::SNS::Subscription', 0);
  });
});

describe('edge without a domain (default)', () => {
  it('serves HTTP on the ALB name and routes API paths to the api target group', () => {
    const platform = app.template(app.env('dev').platform);
    const listener = only(resources(platform, 'AWS::ElasticLoadBalancingV2::Listener'));
    expect(listener.Properties).toMatchObject({ Port: 80, Protocol: 'HTTP' });
    expect(JSON.stringify(listener.Properties.DefaultActions)).toContain('WebTargetGroup');
    const rules = Object.values(resources(platform, 'AWS::ElasticLoadBalancingV2::ListenerRule'));
    expect(rules.map((r) => JSON.stringify(r.Properties.Actions))).toEqual([
      expect.stringContaining('ApiTargetGroup'),
      expect.stringContaining('ApiTargetGroup'),
    ]);
    const patterns = rules.flatMap(
      (r) =>
        (r.Properties.Conditions as { PathPatternConfig: { Values: string[] } }[])[0]!.PathPatternConfig
          .Values,
    );
    expect(patterns).toEqual(API_PATH_PATTERNS.flat());
    platform.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    platform.resourceCountIs('AWS::Route53::RecordSet', 0);
  });

  it('health checks both target groups on /healthz', () => {
    const platform = app.template(app.env('dev').platform);
    const groups = Object.values(resources(platform, 'AWS::ElasticLoadBalancingV2::TargetGroup'));
    expect(
      groups.map((g) => [g.Properties.Port, g.Properties.HealthCheckPath, g.Properties.TargetType]),
    ).toEqual([
      [4000, '/healthz', 'ip'],
      [3000, '/healthz', 'ip'],
    ]);
  });

  it('only registers localhost callbacks with Cognito (sign-in needs a domain)', () => {
    const data = app.template(app.env('prod').data);
    data.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: ['http://localhost:3000/auth/callback'],
      AllowedOAuthFlows: ['code'],
      GenerateSecret: true,
    });
    data.resourceCountIs('AWS::SES::EmailIdentity', 0);
  });
});

describe('edge with a domain and hosted zone', () => {
  let withDomain: Synthesized;
  beforeAll(() => {
    withDomain = synth({
      'prod.domainName': 'example.com',
      'prod.hostedZoneId': 'Z0123456789ABCDEFGHIJ',
      'dev.domainName': 'dev.example.com',
      'dev.hostedZoneId': 'Z0123456789ABCDEFGHIJ',
      'dev.hostedZoneName': 'example.com',
    });
  });

  it('terminates TLS with a DNS-validated certificate and redirects HTTP', () => {
    const platform = withDomain.template(withDomain.env('prod').platform);
    platform.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'app.example.com',
      SubjectAlternativeNames: ['api.example.com'],
      ValidationMethod: 'DNS',
      DomainValidationOptions: Match.arrayWith([
        { DomainName: 'app.example.com', HostedZoneId: 'Z0123456789ABCDEFGHIJ' },
      ]),
    });
    platform.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-PQ-2025-09',
      DefaultActions: [Match.objectLike({ Type: 'fixed-response' })],
    });
    platform.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [
        { Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } },
      ],
    });
  });

  it('routes by host name and creates alias records', () => {
    const platform = withDomain.template(withDomain.env('prod').platform);
    const rules = Object.values(resources(platform, 'AWS::ElasticLoadBalancingV2::ListenerRule')).map(
      (r) => ({
        host: (r.Properties.Conditions as { HostHeaderConfig: { Values: string[] } }[])[0]!.HostHeaderConfig
          .Values,
        target: JSON.stringify(r.Properties.Actions).includes('ApiTargetGroup') ? 'api' : 'web',
      }),
    );
    expect(rules).toEqual([
      { host: ['api.example.com'], target: 'api' },
      { host: ['app.example.com'], target: 'web' },
    ]);
    const records = Object.values(resources(platform, 'AWS::Route53::RecordSet')).map((r) => [
      r.Properties.Name,
      r.Properties.Type,
    ]);
    expect(records).toEqual([
      ['api.example.com.', 'A'],
      ['app.example.com.', 'A'],
    ]);
  });

  it('uses https URLs for the apps and registers them with Cognito', () => {
    const [prod, dev] = [withDomain.env('prod'), withDomain.env('dev')];
    const services = withDomain.template(prod.services);
    expect(environment(container(services, 'api'))).toMatchObject({
      WEB_BASE_URL: 'https://app.example.com',
      API_BASE_URL: 'https://api.example.com',
      EMAIL_FROM: 'Lodgent Bookings <bookings@example.com>',
    });
    withDomain.template(prod.data).hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: ['https://app.example.com/auth/callback'],
      LogoutURLs: ['https://app.example.com/login'],
    });
    withDomain.template(dev.data).hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: ['https://app.dev.example.com/auth/callback', 'http://localhost:3000/auth/callback'],
    });
  });

  it('verifies the SES domain with DKIM records in the (parent) zone', () => {
    const data = withDomain.template(withDomain.env('dev').data);
    data.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'dev.example.com',
      MailFromAttributes: { MailFromDomain: 'mail.dev.example.com' },
      ConfigurationSetAttributes: {
        ConfigurationSetName: { Ref: Match.stringLikeRegexp('^EmailConfigurationSet') },
      },
    });
    data.hasResourceProperties('AWS::SES::ConfigurationSet', { Name: 'lodgent-dev' });
    const records = Object.values(resources(data, 'AWS::Route53::RecordSet'));
    expect(records.filter((r) => r.Properties.Type === 'CNAME')).toHaveLength(3);
    expect(records.map((r) => r.Properties.Name)).toEqual(expect.arrayContaining(['mail.dev.example.com.']));
    for (const record of records) expect(record.Properties.HostedZoneId).toBe('Z0123456789ABCDEFGHIJ');
    data.hasResourceProperties('AWS::SES::ConfigurationSet', {
      DeliveryOptions: { TlsPolicy: 'REQUIRE' },
    });
  });

  it('imports an existing certificate instead of requesting one', () => {
    const imported = synth({
      'prod.domainName': 'example.com',
      'prod.certificateArn': 'arn:aws:acm:eu-central-1:111122223333:certificate/abc',
    });
    const platform = imported.template(imported.env('prod').platform);
    platform.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    platform.resourceCountIs('AWS::Route53::RecordSet', 0);
    platform.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Certificates: [{ CertificateArn: 'arn:aws:acm:eu-central-1:111122223333:certificate/abc' }],
    });
  });
});
