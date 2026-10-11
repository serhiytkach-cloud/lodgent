import { ArnFormat, CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { type EnvName, type GithubConfig, resourceNames } from './config';

export const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_HOST = 'token.actions.githubusercontent.com';

export interface GithubDeployStackProps extends StackProps {
  slug: string;
  github: GithubConfig;
}

/**
 * GitHub Actions deploy access, deployed once per AWS account by an administrator:
 * the account's GitHub OIDC identity provider (or an existing one) and, per environment, a role
 * that only workflow jobs of the configured repository running in the matching GitHub environment
 * can assume. The role can:
 *  - assume the CDK bootstrap roles (that is how `cdk deploy` works; what CloudFormation may then
 *    change is governed by the bootstrap's execution policy),
 *  - push images to the environment's three ECR repositories,
 *  - run and watch the migration task, including a temporary revision of it with the new image
 *    (ECS cannot override a container image per run), passing only the migration task's two roles,
 *  - read the environment's stack outputs and exports and wait for service rollouts.
 * Everything regional is limited to the environment's region.
 */
export class GithubDeployStack extends Stack {
  readonly roles: Partial<Record<EnvName, iam.Role>> = {};

  constructor(scope: Construct, id: string, props: GithubDeployStackProps) {
    super(scope, id, props);
    const { github, slug } = props;

    const provider = github.oidcProviderArn
      ? iam.OidcProviderNative.fromOidcProviderArn(this, 'GithubOidcProvider', github.oidcProviderArn)
      : new iam.OidcProviderNative(this, 'GithubOidcProvider', {
          url: GITHUB_OIDC_URL,
          clientIds: ['sts.amazonaws.com'],
        });

    for (const envName of github.envs) {
      const names = resourceNames(slug, envName);
      const envTitle = `${envName[0]!.toUpperCase()}${envName.slice(1)}`;
      const role = new iam.Role(this, `${envTitle}DeployRole`, {
        roleName: `${names.prefix}-github-deploy`,
        description: `GitHub Actions (${github.repo}, environment ${envName}) deploys ${names.prefix}`,
        maxSessionDuration: Duration.hours(1),
        assumedBy: new iam.OpenIdConnectPrincipal(provider, {
          StringEquals: {
            [`${GITHUB_OIDC_HOST}:aud`]: 'sts.amazonaws.com',
            [`${GITHUB_OIDC_HOST}:sub`]: `repo:${github.repo}:environment:${envName}`,
          },
        }),
      });

      // Everything but IAM is regional: the role acts only in its environment's region.
      const region = github.envRegions[envName];
      const arn = (service: string, resource: string, resourceName: string, arnRegion = region) =>
        this.formatArn({ service, resource, resourceName, region: arnRegion });
      const clusterArn = arn('ecs', 'cluster', names.cluster);
      // For the few actions without resource-level permissions.
      const inRegion = { StringEquals: { 'aws:RequestedRegion': region } };

      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'AssumeCdkBootstrapRoles',
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [arn('iam', 'role', `cdk-${github.cdkQualifier}-*-${this.account}-${region}`, '')],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'EcrLogin',
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
          conditions: inRegion,
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'PushImages',
          actions: [
            'ecr:BatchCheckLayerAvailability',
            'ecr:BatchGetImage',
            'ecr:CompleteLayerUpload',
            'ecr:DescribeImages',
            'ecr:DescribeRepositories',
            'ecr:GetDownloadUrlForLayer',
            'ecr:InitiateLayerUpload',
            'ecr:PutImage',
            'ecr:UploadLayerPart',
          ],
          resources: (['api', 'worker', 'web'] as const).map((service) =>
            arn('ecr', 'repository', names.repository(service)),
          ),
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ReadAndRegisterTaskDefinitions',
          // No resource-level permissions for these; running is still limited to the migrate family
          // on this cluster, and only the migration roles can be passed.
          actions: [
            'ecs:DescribeTaskDefinition',
            'ecs:RegisterTaskDefinition',
            'ecs:DeregisterTaskDefinition',
          ],
          resources: ['*'],
          conditions: inRegion,
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'RunMigrationTask',
          actions: ['ecs:RunTask'],
          resources: [arn('ecs', 'task-definition', `${names.migrateFamily}:*`)],
          conditions: { ArnEquals: { 'ecs:cluster': clusterArn } },
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'TagMigrationTask',
          actions: ['ecs:TagResource'],
          resources: [arn('ecs', 'task', `${names.cluster}/*`)],
          conditions: { StringEquals: { 'ecs:CreateAction': 'RunTask' } },
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'WatchTasksAndServices',
          actions: ['ecs:DescribeTasks', 'ecs:StopTask', 'ecs:DescribeServices'],
          resources: [arn('ecs', 'task', `${names.cluster}/*`), arn('ecs', 'service', `${names.cluster}/*`)],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'PassMigrationRoles',
          actions: ['iam:PassRole'],
          resources: [names.migrateExecutionRole, names.migrateTaskRole].map((role) =>
            arn('iam', 'role', role, ''),
          ),
          conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ReadMigrationLogs',
          actions: ['logs:GetLogEvents', 'logs:FilterLogEvents', 'logs:DescribeLogStreams'],
          resources: [
            this.formatArn({
              service: 'logs',
              region,
              resource: 'log-group',
              resourceName: `${names.logGroup('migrate')}:*`,
              arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            }),
          ],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ReadStackOutputs',
          actions: ['cloudformation:DescribeStacks'],
          resources: [arn('cloudformation', 'stack', `${names.prefix}-*/*`)],
        }),
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ReadStackExports',
          // ListExports has no resource-level permissions.
          actions: ['cloudformation:ListExports'],
          resources: ['*'],
          conditions: inRegion,
        }),
      );
      this.roles[envName] = role;

      new CfnOutput(this, `${envTitle}DeployRoleArn`, {
        description: `Role for the GitHub environment "${envName}" (aws-actions/configure-aws-credentials role-to-assume)`,
        value: role.roleArn,
        exportName: names.exportName('GithubDeployRoleArn'),
      });
    }
  }
}
