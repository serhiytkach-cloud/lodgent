import { Match } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP_SECRET_KEYS } from '../lib/data-stack';
import { DB_PORT } from '../lib/network-stack';
import {
  actionsOf,
  container,
  containers,
  environment,
  only,
  resources,
  type Synthesized,
  statementsForRole,
  synth,
} from './helpers';

let app: Synthesized;
beforeAll(() => {
  app = synth();
});

describe('database', () => {
  for (const env of ['dev', 'prod'] as const) {
    it(`${env}: is encrypted with the customer key, private and in isolated subnets`, () => {
      const data = app.template(app.env(env).data);
      const db = only(resources(data, 'AWS::RDS::DBInstance'));
      expect(db.Properties).toMatchObject({
        StorageEncrypted: true,
        PubliclyAccessible: false,
        Engine: 'postgres',
        EngineVersion: '16',
        EnablePerformanceInsights: true,
        CACertificateIdentifier: 'rds-ca-rsa2048-g1',
      });
      const keyRef = { 'Fn::GetAtt': [expect.stringMatching(/^DataKey/), 'Arn'] };
      expect(db.Properties.KmsKeyId).toEqual(keyRef);
      expect(db.Properties.PerformanceInsightsKMSKeyId).toEqual(keyRef);

      const subnetGroup = only(resources(data, 'AWS::RDS::DBSubnetGroup'));
      for (const subnet of subnetGroup.Properties.SubnetIds as unknown[]) {
        expect(JSON.stringify(subnet)).toMatch(/VpcdataSubnet/);
      }
    });

    it(`${env}: forces TLS through the parameter group`, () => {
      const data = app.template(app.env(env).data);
      data.hasResourceProperties('AWS::RDS::DBParameterGroup', {
        Family: 'postgres16',
        Parameters: Match.objectLike({ 'rds.force_ssl': '1' }),
      });
    });

    it(`${env}: only the api, worker and one-off task security groups reach PostgreSQL`, () => {
      const network = app.template(app.env(env).network);
      const groups = resources(network, 'AWS::EC2::SecurityGroup');
      const dbGroupId = Object.keys(groups).find((id) => id.startsWith('DatabaseSecurityGroup'))!;
      // No inline ingress on the database group at all.
      expect(groups[dbGroupId]!.Properties.SecurityGroupIngress ?? []).toEqual([]);

      const ingress = Object.values(resources(network, 'AWS::EC2::SecurityGroupIngress')).filter((rule) =>
        JSON.stringify(rule.Properties.GroupId).includes(dbGroupId),
      );
      const sources = ingress.map((rule) => {
        expect(rule.Properties).not.toHaveProperty('CidrIp');
        expect(rule.Properties).not.toHaveProperty('CidrIpv6');
        expect(rule.Properties).toMatchObject({ FromPort: DB_PORT, ToPort: DB_PORT, IpProtocol: 'tcp' });
        return (rule.Properties.SourceSecurityGroupId as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0];
      });
      expect(sources.map((s) => s.replace(/[0-9A-F]{8}$/, '')).sort()).toEqual([
        'ApiSecurityGroup',
        'OneOffTaskSecurityGroup',
        'WorkerSecurityGroup',
      ]);
    });
  }

  it('prod: Multi-AZ, deletion protection, 30-day backups and retained on stack deletion', () => {
    const data = app.template(app.env('prod').data);
    const db = only(resources(data, 'AWS::RDS::DBInstance'));
    expect(db.Properties).toMatchObject({
      MultiAZ: true,
      DeletionProtection: true,
      BackupRetentionPeriod: 30,
    });
    expect(db.DeletionPolicy).toBe('Retain');
    for (const type of [
      'AWS::KMS::Key',
      'AWS::SecretsManager::Secret',
      'AWS::Cognito::UserPool',
      'AWS::ECR::Repository',
    ]) {
      for (const [id, resource] of Object.entries(resources(data, type))) {
        expect(resource.DeletionPolicy, `${type} ${id}`).toBe('Retain');
      }
    }
    data.hasResourceProperties('AWS::Cognito::UserPool', { DeletionProtection: 'ACTIVE' });
  });

  it('dev: single-AZ, no deletion protection, snapshot on deletion', () => {
    const data = app.template(app.env('dev').data);
    const db = only(resources(data, 'AWS::RDS::DBInstance'));
    expect(db.Properties).toMatchObject({ MultiAZ: false, DeletionProtection: false });
    expect(db.DeletionPolicy).toBe('Snapshot');
  });
});

describe('network exposure', () => {
  it('only the load balancer accepts traffic from the internet, on 80 and 443', () => {
    for (const env of ['dev', 'prod'] as const) {
      const network = app.template(app.env(env).network);
      const open: string[] = [];
      for (const [id, group] of Object.entries(resources(network, 'AWS::EC2::SecurityGroup'))) {
        for (const rule of (group.Properties.SecurityGroupIngress ?? []) as Record<string, unknown>[]) {
          if (rule.CidrIp === '0.0.0.0/0' || rule.CidrIpv6 === '::/0') open.push(`${id}:${rule.FromPort}`);
        }
      }
      for (const [id, rule] of Object.entries(resources(network, 'AWS::EC2::SecurityGroupIngress'))) {
        if (rule.Properties.CidrIp === '0.0.0.0/0') open.push(`${id}:${rule.Properties.FromPort}`);
      }
      expect(open.map((entry) => entry.replace(/[0-9A-F]{8}:/, ':')).sort()).toEqual([
        'AlbSecurityGroup:443',
        'AlbSecurityGroup:80',
      ]);
    }
  });

  it('runs tasks in private subnets without public IPs', () => {
    const services = app.template(app.env('prod').services);
    for (const service of Object.values(resources(services, 'AWS::ECS::Service'))) {
      expect(service.Properties.NetworkConfiguration).toMatchObject({
        AwsvpcConfiguration: { AssignPublicIp: 'DISABLED' },
      });
      for (const subnet of (
        service.Properties.NetworkConfiguration as { AwsvpcConfiguration: { Subnets: unknown[] } }
      ).AwsvpcConfiguration.Subnets) {
        expect(JSON.stringify(subnet)).toMatch(/VpcappSubnet/);
      }
    }
  });

  it('logs VPC flows and keeps S3 traffic on a gateway endpoint; prod adds interface endpoints', () => {
    const dev = app.template(app.env('dev').network);
    const prod = app.template(app.env('prod').network);
    for (const network of [dev, prod]) {
      network.resourceCountIs('AWS::EC2::FlowLog', 1);
      network.hasResourceProperties('AWS::EC2::VPCEndpoint', {
        VpcEndpointType: 'Gateway',
        ServiceName: Match.objectLike({}),
      });
    }
    const interfaces = (t: typeof dev) =>
      Object.values(resources(t, 'AWS::EC2::VPCEndpoint')).filter(
        (e) => e.Properties.VpcEndpointType === 'Interface',
      ).length;
    expect(interfaces(dev)).toBe(0);
    expect(interfaces(prod)).toBe(6);
  });
});

describe('jobs queue', () => {
  it('has a dead-letter queue, server-side encryption and TLS-only access', () => {
    const data = app.template(app.env('prod').data);
    const queues = resources(data, 'AWS::SQS::Queue');
    const jobs = Object.entries(queues).find(([, q]) => q.Properties.QueueName === 'lodgent-prod-jobs')![1];
    const dlqId = Object.entries(queues).find(
      ([, q]) => q.Properties.QueueName === 'lodgent-prod-jobs-dlq',
    )![0];
    expect(jobs.Properties.RedrivePolicy).toEqual({
      deadLetterTargetArn: { 'Fn::GetAtt': [dlqId, 'Arn'] },
      maxReceiveCount: 5,
    });
    for (const queue of Object.values(queues)) expect(queue.Properties.SqsManagedSseEnabled).toBe(true);
    const policies = resources(data, 'AWS::SQS::QueuePolicy');
    expect(Object.keys(policies)).toHaveLength(2);
    for (const policy of Object.values(policies)) {
      expect(JSON.stringify(policy.Properties.PolicyDocument)).toContain('"aws:SecureTransport":"false"');
    }
  });
});

describe('load balancer', () => {
  it('is protected by the WAF web ACL', () => {
    const platform = app.template(app.env('prod').platform);
    const lbId = Object.keys(resources(platform, 'AWS::ElasticLoadBalancingV2::LoadBalancer'))[0]!;
    const aclId = Object.keys(resources(platform, 'AWS::WAFv2::WebACL'))[0]!;
    platform.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
      ResourceArn: { Ref: lbId },
      WebACLArn: { 'Fn::GetAtt': [aclId, 'Arn'] },
    });
    platform.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      LoadBalancerAttributes: Match.arrayWith([
        { Key: 'deletion_protection.enabled', Value: 'true' },
        { Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
        { Key: 'access_logs.s3.enabled', Value: 'true' },
      ]),
    });
  });

  it('uses the AWS managed rule groups and a rate limit, with narrow body-size exceptions', () => {
    const platform = app.template(app.env('prod').platform);
    const acl = only(resources(platform, 'AWS::WAFv2::WebACL'));
    const rules = acl.Properties.Rules as Record<string, unknown>[];
    const managed = rules
      .map(
        (r) =>
          (r.Statement as { ManagedRuleGroupStatement?: { Name: string } }).ManagedRuleGroupStatement?.Name,
      )
      .filter(Boolean);
    expect(managed).toEqual([
      'AWSManagedRulesAmazonIpReputationList',
      'AWSManagedRulesCommonRuleSet',
      'AWSManagedRulesKnownBadInputsRuleSet',
      'AWSManagedRulesSQLiRuleSet',
    ]);
    expect(acl.Properties.Scope).toBe('REGIONAL');

    const rate = rules.find((r) => r.Name === 'RateLimitPerIp')!;
    expect(rate.Action).toEqual({ Block: {} });
    expect(rate.Statement).toMatchObject({ RateBasedStatement: { AggregateKeyType: 'IP', Limit: 2000 } });

    // Only the two CRS rules are switched to count, and both are re-enforced by our own rules.
    const crs = rules.find((r) => r.Name === 'AWSManagedRulesCommonRuleSet')!;
    expect(
      (crs.Statement as { ManagedRuleGroupStatement: { RuleActionOverrides: unknown[] } })
        .ManagedRuleGroupStatement.RuleActionOverrides,
    ).toEqual([
      { Name: 'SizeRestrictions_BODY', ActionToUse: { Count: {} } },
      { Name: 'NoUserAgent_HEADER', ActionToUse: { Count: {} } },
    ]);
    const bodyRule = JSON.stringify(rules.find((r) => r.Name === 'BodySizeLimitExceptLargeBodyPaths'));
    expect(bodyRule).toContain('awswaf:managed:aws:core-rule-set:SizeRestrictions_Body');
    expect(bodyRule).toContain('"Block":{}');
    const exempt = [...bodyRule.matchAll(/"PositionalConstraint":"(\w+)","SearchString":"([^"]+)"/g)].map(
      (m) => `${m[1]} ${m[2]}`,
    );
    expect(exempt.sort()).toEqual(['EXACTLY /mcp', 'STARTS_WITH /app/', 'STARTS_WITH /webhooks/']);
    const uaRule = JSON.stringify(rules.find((r) => r.Name === 'NoUserAgentExceptWebhooks'));
    expect(uaRule).toContain('awswaf:managed:aws:core-rule-set:NoUserAgent_Header');
    expect(uaRule).toContain('"SearchString":"/webhooks/"');
  });

  it('writes access logs to an encrypted, private, TLS-only bucket', () => {
    const platform = app.template(app.env('prod').platform);
    platform.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    const policy = only(resources(platform, 'AWS::S3::BucketPolicy'));
    expect(JSON.stringify(policy.Properties.PolicyDocument)).toContain('"aws:SecureTransport":"false"');
  });
});

describe('ECS tasks', () => {
  const secretNames = new Set<string>([...APP_SECRET_KEYS, 'DATABASE_USER', 'DATABASE_PASSWORD']);

  it('never run privileged or with added capabilities', () => {
    for (const env of ['dev', 'prod'] as const) {
      const all = [
        ...containers(app.template(app.env(env).services)),
        ...containers(app.template(app.env(env).platform)),
      ];
      expect(all.map((c) => c.Name).sort()).toEqual([
        'api',
        'migrate',
        'otel-collector',
        'otel-collector',
        'web',
        'worker',
      ]);
      for (const c of all) {
        expect(c.Privileged, c.Name).toBeFalsy();
        expect(c.LinuxParameters?.Capabilities?.Add ?? [], c.Name).toEqual([]);
      }
    }
  });

  it('get secrets from Secrets Manager, never as plain environment', () => {
    for (const env of ['dev', 'prod'] as const) {
      const all = [
        ...containers(app.template(app.env(env).services)),
        ...containers(app.template(app.env(env).platform)),
      ];
      for (const c of all) {
        for (const name of Object.keys(environment(c)))
          expect(secretNames.has(name), `${c.Name} ${name}`).toBe(false);
        for (const secret of c.Secrets ?? []) {
          // <secret ARN>:<json key>:: from the data stack's secrets
          expect(JSON.stringify(secret.ValueFrom)).toMatch(
            new RegExp(`lodgent-${env}-data:ExportsOutputRef(AppSecret|DatabaseCredentials)`),
          );
          expect(JSON.stringify(secret.ValueFrom)).toContain(
            `:${secret.Name === 'DATABASE_USER' ? 'username' : secret.Name === 'DATABASE_PASSWORD' ? 'password' : secret.Name}::`,
          );
        }
      }
    }
  });

  it('give each container only the secrets it needs', () => {
    const services = app.template(app.env('prod').services);
    const names = (name: string) => (container(services, name).Secrets ?? []).map((s) => s.Name).sort();
    const appKeys = APP_SECRET_KEYS.filter((k) => k !== 'COGNITO_CLIENT_SECRET');
    expect(names('api')).toEqual([...appKeys, 'DATABASE_PASSWORD', 'DATABASE_USER'].sort());
    expect(names('worker')).toEqual(names('api'));
    expect(names('web')).toEqual(['COGNITO_CLIENT_SECRET']);
    const platform = app.template(app.env('prod').platform);
    expect((container(platform, 'migrate').Secrets ?? []).map((s) => s.Name).sort()).toEqual([
      'DATABASE_PASSWORD',
      'DATABASE_USER',
    ]);
  });

  it('run api, worker and migrations with a read-only root filesystem', () => {
    const services = app.template(app.env('prod').services);
    const platform = app.template(app.env('prod').platform);
    for (const c of [
      container(services, 'api'),
      container(services, 'worker'),
      container(platform, 'migrate'),
    ]) {
      expect(c.ReadonlyRootFilesystem, c.Name).toBe(true);
    }
  });

  it('deploy with circuit-breaker rollback and zero-downtime percentages', () => {
    const services = app.template(app.env('prod').services);
    for (const service of Object.values(resources(services, 'AWS::ECS::Service'))) {
      expect(service.Properties.DeploymentConfiguration).toEqual({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MaximumPercent: 200,
        MinimumHealthyPercent: 100,
      });
      expect(service.Properties.EnableExecuteCommand).toBe(false);
    }
  });
});

describe('task roles (least privilege)', () => {
  const roleId = (stack: ReturnType<Synthesized['template']>, prefix: string) =>
    Object.keys(resources(stack, 'AWS::IAM::Role')).find((id) => id.startsWith(prefix))!;

  it('api: token key and enqueue only', () => {
    const services = app.template(app.env('prod').services);
    const actions = actionsOf(statementsForRole(services, roleId(services, 'ApiTaskDefinitionTaskRole')));
    expect(actions).toEqual(
      expect.arrayContaining(['kms:GenerateDataKey', 'kms:Decrypt', 'sqs:SendMessage']),
    );
    expect(actions).not.toContain('sqs:ReceiveMessage');
    expect(actions.some((a) => a.startsWith('ses:'))).toBe(false);
    expect(actions).not.toContain('kms:*');
  });

  it('worker: token key, consume and enqueue jobs, send email', () => {
    const services = app.template(app.env('prod').services);
    const actions = actionsOf(statementsForRole(services, roleId(services, 'WorkerTaskDefinitionTaskRole')));
    expect(actions).toEqual(
      expect.arrayContaining([
        'kms:GenerateDataKey',
        'kms:Decrypt',
        'sqs:SendMessage',
        'sqs:ReceiveMessage',
        'sqs:DeleteMessage',
        'ses:SendEmail',
        'xray:PutTraceSegments',
      ]),
    );
  });

  it('web: no AWS data access', () => {
    const services = app.template(app.env('prod').services);
    const actions = actionsOf(statementsForRole(services, roleId(services, 'WebTaskDefinitionTaskRole')));
    expect(actions.filter((a) => /^(kms|sqs|ses|secretsmanager):/.test(a))).toEqual([]);
  });

  it('execution roles decrypt the data key only through Secrets Manager', () => {
    const services = app.template(app.env('prod').services);
    for (const prefix of ['ApiTaskDefinitionExecutionRole', 'WebTaskDefinitionExecutionRole']) {
      const statements = statementsForRole(services, roleId(services, prefix)).filter((s) =>
        actionsOf([s]).some((a) => a.startsWith('kms:')),
      );
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatchObject({
        Action: 'kms:Decrypt',
        Condition: { StringEquals: { 'kms:ViaService': 'secretsmanager.eu-central-1.amazonaws.com' } },
      });
    }
  });
});

describe('app secret', () => {
  it('is created with every key and no values except the generated signing secret', () => {
    for (const env of ['dev', 'prod'] as const) {
      const data = app.template(app.env(env).data);
      const secret = Object.values(resources(data, 'AWS::SecretsManager::Secret')).find(
        (s) => s.Properties.Name === `lodgent/${env}/app`,
      )!;
      const generate = secret.Properties.GenerateSecretString as {
        SecretStringTemplate: string;
        GenerateStringKey: string;
      };
      const template = JSON.parse(generate.SecretStringTemplate) as Record<string, string>;
      expect([...Object.keys(template), generate.GenerateStringKey].sort()).toEqual(
        [...APP_SECRET_KEYS].sort(),
      );
      expect(Object.values(template).every((value) => value === '')).toBe(true);
      expect(secret.Properties).not.toHaveProperty('SecretString');
    }
  });
});
