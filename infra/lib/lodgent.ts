import { BRAND } from '@lodgent/shared';
import type { App } from 'aws-cdk-lib';
import {
  type EnvConfig,
  type EnvName,
  loadEnvConfig,
  loadGithubConfig,
  selectedEnvironments,
} from './config';
import { DataStack } from './data-stack';
import { GithubDeployStack } from './github-deploy-stack';
import { NetworkStack } from './network-stack';
import { PlatformStack } from './platform-stack';
import { ServicesStack } from './services-stack';

export interface EnvironmentStacks {
  config: EnvConfig;
  network: NetworkStack;
  data: DataStack;
  platform: PlatformStack;
  services: ServicesStack;
}

export interface LodgentStacks {
  /** Every environment, or only the one named by the `env` context (`-c env=dev`). */
  environments: Partial<Record<EnvName, EnvironmentStacks>>;
  github: GithubDeployStack;
}

/**
 * Defines every stack. Per environment, in deploy order:
 *   <slug>-<env>-network → -data → -platform → (migration task) → -services
 * plus `<slug>-github-deploy`, deployed once per account by an administrator.
 */
export function defineStacks(app: App): LodgentStacks {
  const environments: Partial<Record<EnvName, EnvironmentStacks>> = {};
  for (const envName of selectedEnvironments(app.node)) {
    const config = loadEnvConfig(app.node, envName);
    const { names } = config;
    const common = {
      config,
      env: { region: config.region },
      tags: { app: config.slug, env: envName },
      terminationProtection: config.protectData,
    };
    const network = new NetworkStack(app, names.stack('network'), {
      ...common,
      description: `${BRAND.name} ${envName}: VPC, endpoints, flow logs, security groups`,
    });
    const data = new DataStack(app, names.stack('data'), {
      ...common,
      network,
      description: `${BRAND.name} ${envName}: KMS, PostgreSQL, secrets, SQS, ECR, Cognito, SES`,
    });
    const platform = new PlatformStack(app, names.stack('platform'), {
      ...common,
      network,
      data,
      description: `${BRAND.name} ${envName}: ECS cluster, ALB + WAF, migration task, schedules, alarms`,
    });
    const services = new ServicesStack(app, names.stack('services'), {
      ...common,
      network,
      data,
      platform,
      description: `${BRAND.name} ${envName}: api, worker and web services, autoscaling, dashboard`,
    });
    environments[envName] = { config, network, data, platform, services };
  }

  const github = loadGithubConfig(app.node);
  const githubStack = new GithubDeployStack(app, `${BRAND.slug}-github-deploy`, {
    slug: BRAND.slug,
    github,
    env: { region: github.region },
    tags: { app: BRAND.slug, env: 'shared' },
    description: `${BRAND.name}: GitHub Actions OIDC provider and deploy roles (deploy once per account)`,
  });
  return { environments, github: githubStack };
}
