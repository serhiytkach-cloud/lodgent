import { App } from 'aws-cdk-lib';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnvConfig, loadGithubConfig } from '../lib/config';
import { estimatedMaxConnections } from '../lib/platform-stack';
import { actionsOf, only, resources, statementsForRole, synth } from './helpers';

describe('GitHub deploy roles', () => {
  const app = synth();
  const github = app.template(app.stacks.github);
  const roles = resources(github, 'AWS::IAM::Role');

  it('creates the OIDC provider for GitHub Actions with the STS audience', () => {
    github.hasResourceProperties('AWS::IAM::OIDCProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIdList: ['sts.amazonaws.com'],
    });
  });

  it('trusts only the repository and the matching GitHub environment', () => {
    for (const env of ['dev', 'prod']) {
      const role = Object.values(roles).find(
        (r) => r.Properties.RoleName === `lodgent-${env}-github-deploy`,
      )!;
      const statements = (
        role.Properties.AssumeRolePolicyDocument as { Statement: Record<string, unknown>[] }
      ).Statement;
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatchObject({
        Effect: 'Allow',
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': `repo:serhiytkach-cloud/lodgent:environment:${env}`,
          },
        },
      });
      // No wildcard subject (StringLike) that would admit other repositories, branches or environments.
      expect(JSON.stringify(statements[0])).not.toContain('StringLike');
      expect(JSON.stringify(statements[0])).not.toMatch(/\*/);
    }
  });

  it('allows the CDK bootstrap roles, ECR push, the migration task and nothing account-wide', () => {
    const roleId = Object.keys(roles).find((id) => id.startsWith('ProdDeployRole'))!;
    const statements = statementsForRole(github, roleId);
    const bySid = Object.fromEntries(statements.map((s) => [s.Sid as string, s]));
    expect(Object.keys(bySid).sort()).toEqual([
      'AssumeCdkBootstrapRoles',
      'EcrLogin',
      'PassMigrationRoles',
      'PushImages',
      'ReadAndRegisterTaskDefinitions',
      'ReadMigrationLogs',
      'ReadStackExports',
      'ReadStackOutputs',
      'RunMigrationTask',
      'TagMigrationTask',
      'WatchTasksAndServices',
    ]);
    expect(JSON.stringify(bySid.AssumeCdkBootstrapRoles!.Resource)).toContain(':role/cdk-hnb659fds-*-');
    expect(JSON.stringify(bySid.PushImages!.Resource)).toContain('repository/lodgent-prod-api');
    expect(JSON.stringify(bySid.PushImages!.Resource)).not.toContain('lodgent-dev');
    expect(bySid.RunMigrationTask!.Condition).toBeDefined();
    expect(JSON.stringify(bySid.RunMigrationTask!.Resource)).toContain(
      'task-definition/lodgent-prod-migrate:*',
    );
    expect(bySid.PassMigrationRoles!.Condition).toEqual({
      StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
    });
    // "*" only where IAM has no resource-level permissions for the (read/register-only) actions.
    const unscoped = statements.filter((s) => s.Resource === '*');
    expect(actionsOf(unscoped).sort()).toEqual([
      'cloudformation:ListExports',
      'ecr:GetAuthorizationToken',
      'ecs:DeregisterTaskDefinition',
      'ecs:DescribeTaskDefinition',
      'ecs:RegisterTaskDefinition',
    ]);
    const actions = actionsOf(statements);
    expect(actions.some((a) => a.endsWith(':*') || a === '*')).toBe(false);
    expect(actions).not.toContain('iam:CreateRole');
  });

  it('honours githubRepo, githubDeployEnvs and an existing OIDC provider', () => {
    const custom = synth({
      githubRepo: 'acme/booking',
      githubDeployEnvs: 'prod',
      githubOidcProviderArn: 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com',
    });
    const template = custom.template(custom.stacks.github);
    template.resourceCountIs('AWS::IAM::OIDCProvider', 0);
    const role = only(resources(template, 'AWS::IAM::Role'));
    expect(role.Properties.RoleName).toBe('lodgent-prod-github-deploy');
    expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).toContain(
      '"token.actions.githubusercontent.com:sub":"repo:acme/booking:environment:prod"',
    );
    expect(JSON.stringify(role.Properties.AssumeRolePolicyDocument)).toContain(
      'oidc-provider/token.actions.githubusercontent.com',
    );
  });
});

describe('context validation', () => {
  const node = (context: Record<string, unknown>) => new App({ context }).node;

  it('has safe offline defaults', () => {
    const dev = loadEnvConfig(node({}), 'dev');
    expect(dev).toMatchObject({ region: 'eu-central-1', imageTag: 'latest', edge: { kind: 'alb-dns' } });
    expect(dev.names).toMatchObject({
      prefix: 'lodgent-dev',
      appSecret: 'lodgent/dev/app',
      pascal: 'LodgentDev',
    });
    expect(dev.names.exportName('ClusterName')).toBe('lodgent-dev-ClusterName');
    expect(loadEnvConfig(node({}), 'prod').protectData).toBe(true);
    expect(loadGithubConfig(node({}))).toMatchObject({
      repo: 'serhiytkach-cloud/lodgent',
      envs: ['dev', 'prod'],
    });
  });

  it('reads cdk.json environments and lets flat -c keys override them', () => {
    const config = loadEnvConfig(
      node({
        environments: { prod: { domainName: 'example.com', api: { maxCount: 10 }, dbMultiAz: false } },
        'prod.api.minCount': '3',
        'prod.dbMultiAz': 'true',
        'prod.appEnvironment': '{"EMBEDDINGS_PROVIDER":"openai"}',
      }),
      'prod',
    );
    expect(config.api).toEqual({ cpu: 1024, memoryMiB: 2048, minCount: 3, maxCount: 10 });
    expect(config.dbMultiAz).toBe(true);
    expect(config.appEnvironment).toEqual({ EMBEDDINGS_PROVIDER: 'openai' });
    expect(config.edge).toEqual({
      kind: 'domain',
      domainName: 'example.com',
      apiHostname: 'api.example.com',
      webHostname: 'app.example.com',
      certificateArn: undefined,
      hostedZone: undefined,
    });
  });

  it.each([
    [{ 'dev.hostedZoneId': 'Z1' }, /needs dev.domainName/],
    [{ 'dev.domainName': 'not a domain' }, /domainName/],
    [
      { 'dev.domainName': 'a.example.com', 'dev.hostedZoneId': 'Z1', 'dev.hostedZoneName': 'other.com' },
      /hosted zone/,
    ],
    [{ 'dev.api.cpu': '512', 'dev.api.memoryMiB': '512' }, /Fargate/],
    [{ 'dev.api.minCount': '3', 'dev.api.maxCount': '2' }, /minCount/],
    [{ 'dev.logRetentionDays': '10' }, /retention/],
    [{ 'dev.alarmEmail': 'nope' }, /alarmEmail/],
    [{ imageTag: 'bad tag!' }, /imageTag/],
  ])('rejects invalid context %j', (context, message) => {
    expect(() => loadEnvConfig(node(context), 'dev')).toThrow(ConfigError);
    expect(() => loadEnvConfig(node(context), 'dev')).toThrow(message);
  });

  it('refuses secrets in appEnvironment', () => {
    expect(() => synth({ 'dev.appEnvironment': '{"STRIPE_SECRET_KEY":"sk_live_x"}' })).toThrow(
      /must not set/,
    );
  });

  it('rejects an invalid GitHub repository', () => {
    expect(() => loadGithubConfig(node({ githubRepo: 'no-owner' }))).toThrow(ConfigError);
    expect(() => loadGithubConfig(node({ githubDeployEnvs: 'staging' }))).toThrow(ConfigError);
  });
});

describe('database connection alarm threshold', () => {
  it('estimates max_connections from the instance class', () => {
    expect(estimatedMaxConnections('t4g.micro')).toBe(101);
    expect(estimatedMaxConnections('t4g.medium')).toBe(405);
    expect(estimatedMaxConnections('r7g.large')).toBe(1622);
    expect(estimatedMaxConnections('m7g.16xlarge')).toBe(100);
  });
});
