import { BRAND } from '@lodgent/shared';
import type { Node } from 'constructs';
import { z } from 'zod';

/**
 * Deployment configuration from CDK context. Nothing here needs AWS credentials or lookups, so
 * `cdk synth` works offline with no context at all (every feature that needs operator input, such
 * as a domain, is optional and switched off by default).
 *
 * Global context (cdk.json or `-c key=value`):
 *   env                    synthesize only this environment (dev or prod); default both
 *   imageTag               image tag deployed to ECS (the git SHA); default "latest"
 *   region                 AWS region for every stack (per environment: <env>.region); default "eu-central-1"
 *   githubRepo             "owner/repo" allowed to assume the deploy roles
 *   githubDeployEnvs       comma-separated environments that get a GitHub deploy role in this account
 *   githubOidcProviderArn  reuse an existing token.actions.githubusercontent.com provider
 *   cdkQualifier           CDK bootstrap qualifier; default "hnb659fds"
 *
 * Per environment: an object under `environments.<env>` in cdk.json, overridden by flat
 * `-c <env>.<key>=<value>` (for example `-c prod.domainName=example.com`). Keys: see EnvSettings.
 */

export const ENV_NAMES = ['dev', 'prod'] as const;
export type EnvName = (typeof ENV_NAMES)[number];

const DEFAULT_REGION = 'eu-central-1';
const DEFAULT_GITHUB_REPO = 'serhiytkach-cloud/lodgent';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalString = z.preprocess(blank, z.string().trim().optional());
const boolish = z.preprocess(
  (v) => (typeof v === 'string' ? (({ true: true, false: false } as Record<string, boolean>)[v] ?? v) : v),
  z.boolean(),
);
const intIn = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'must be a DNS name');

/** Fargate memory range (MiB) per CPU size. */
const FARGATE_MEMORY: Record<number, [number, number]> = {
  256: [512, 2048],
  512: [1024, 4096],
  1024: [2048, 8192],
  2048: [4096, 16384],
};
const ServiceSize = z
  .object({
    cpu: z.coerce.number().pipe(z.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(2048)])),
    memoryMiB: intIn(512, 16384),
    minCount: intIn(0, 20),
    maxCount: intIn(1, 50),
  })
  .refine(
    ({ cpu, memoryMiB }) => {
      const [min, max] = FARGATE_MEMORY[cpu]!;
      return memoryMiB >= min && memoryMiB <= max && (cpu === 256 || memoryMiB % 1024 === 0);
    },
    { message: 'not a valid Fargate CPU/memory combination' },
  );
export type ServiceSize = z.infer<typeof ServiceSize>;

/** Retention periods CloudWatch Logs accepts. */
const LOG_RETENTION_DAYS = [
  1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653,
];

const EnvSettings = z.object({
  /** Apex for the public hostnames (api.<domain>, app.<domain>). Without it the ALB serves plain HTTP on its own DNS name. */
  domainName: z.preprocess(blank, hostname.optional()),
  /** Route 53 public hosted zone that holds domainName: enables DNS-validated certificates, alias and SES records. */
  hostedZoneId: optionalString,
  /** Name of that hosted zone if it is a parent of domainName (default: domainName). */
  hostedZoneName: z.preprocess(blank, hostname.optional()),
  /** Existing ACM certificate covering the API and web hostnames (otherwise one is requested). */
  certificateArn: z.preprocess(blank, z.string().startsWith('arn:').optional()),
  apiHostname: z.preprocess(blank, hostname.optional()),
  webHostname: z.preprocess(blank, hostname.optional()),
  /** "Name <address>" used as the From header; default "<Brand> Bookings <bookings@domainName>". */
  emailFrom: optionalString,
  /** Address subscribed to the alarm topic (confirm the SNS email after deploy). */
  alarmEmail: z.preprocess(blank, z.email().optional()),
  /** Cognito managed-login domain prefix; must be unique in the region. Default "<slug>-<env>-<account id>". */
  cognitoDomainPrefix: z.preprocess(
    blank,
    z
      .string()
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)
      .optional(),
  ),
  /** Cognito threat protection (needs the Plus feature plan, billed per MAU). */
  cognitoThreatProtection: z.enum(['off', 'audit', 'enforced']),
  /** NAT gateways (the VPC spans two AZs): 1 is cheaper, 2 survives the loss of an AZ. */
  natGateways: intIn(1, 2),
  /** Interface VPC endpoints for SQS, Secrets Manager, ECR, Logs and KMS (~$7.50 per endpoint per AZ per month). */
  interfaceEndpoints: boolish,
  flowLogTraffic: z.enum(['ALL', 'REJECT']),
  dbInstanceClass: z.string().regex(/^[a-z0-9]+\.[a-z0-9]+$/, 'like t4g.micro (without the "db." prefix)'),
  dbAllocatedStorageGiB: intIn(20, 1000),
  dbMaxAllocatedStorageGiB: intIn(20, 5000),
  dbMultiAz: boolish,
  dbBackupRetentionDays: intIn(1, 35),
  /** Deletion protection on the database, user pool and load balancer; RETAIN removal policies on data. */
  protectData: boolish,
  logRetentionDays: z.coerce.number().refine((days) => LOG_RETENTION_DAYS.includes(days), {
    message: 'not a CloudWatch Logs retention period',
  }),
  wafRateLimitPer5Min: intIn(10, 2_000_000_000),
  /** Fargate Spot for services (cheaper, can be interrupted with two minutes' notice). */
  fargateSpot: boolish,
  cpuArchitecture: z.enum(['x86_64', 'arm64']),
  enableExecuteCommand: boolish,
  /**
   * Extra plain environment for the api and worker (for example EMBEDDINGS_PROVIDER, APALEO_SCOPES,
   * LOG_LEVEL). Secrets do not belong here: they go into the app secret.
   */
  appEnvironment: z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    },
    z.record(
      z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'environment variable names are UPPER_SNAKE_CASE'),
      z.string(),
    ),
  ),
  api: ServiceSize,
  web: ServiceSize,
  worker: ServiceSize,
});
export type EnvSettings = z.infer<typeof EnvSettings>;

/** Defaults per environment; every key can be overridden from context. */
export const ENV_DEFAULTS: Record<EnvName, EnvSettings> = {
  dev: {
    domainName: undefined,
    hostedZoneId: undefined,
    hostedZoneName: undefined,
    certificateArn: undefined,
    apiHostname: undefined,
    webHostname: undefined,
    emailFrom: undefined,
    alarmEmail: undefined,
    cognitoDomainPrefix: undefined,
    cognitoThreatProtection: 'off',
    natGateways: 1,
    interfaceEndpoints: false,
    flowLogTraffic: 'REJECT',
    dbInstanceClass: 't4g.micro',
    dbAllocatedStorageGiB: 20,
    dbMaxAllocatedStorageGiB: 100,
    dbMultiAz: false,
    dbBackupRetentionDays: 3,
    protectData: false,
    logRetentionDays: 14,
    wafRateLimitPer5Min: 2000,
    fargateSpot: true,
    cpuArchitecture: 'x86_64',
    enableExecuteCommand: false,
    appEnvironment: {},
    api: { cpu: 512, memoryMiB: 1024, minCount: 1, maxCount: 2 },
    web: { cpu: 512, memoryMiB: 1024, minCount: 1, maxCount: 2 },
    worker: { cpu: 512, memoryMiB: 1024, minCount: 1, maxCount: 2 },
  },
  prod: {
    domainName: undefined,
    hostedZoneId: undefined,
    hostedZoneName: undefined,
    certificateArn: undefined,
    apiHostname: undefined,
    webHostname: undefined,
    emailFrom: undefined,
    alarmEmail: undefined,
    cognitoDomainPrefix: undefined,
    cognitoThreatProtection: 'off',
    natGateways: 2,
    interfaceEndpoints: true,
    flowLogTraffic: 'ALL',
    dbInstanceClass: 't4g.medium',
    dbAllocatedStorageGiB: 50,
    dbMaxAllocatedStorageGiB: 500,
    dbMultiAz: true,
    dbBackupRetentionDays: 30,
    protectData: true,
    logRetentionDays: 90,
    wafRateLimitPer5Min: 2000,
    fargateSpot: false,
    cpuArchitecture: 'x86_64',
    enableExecuteCommand: false,
    appEnvironment: {},
    api: { cpu: 1024, memoryMiB: 2048, minCount: 2, maxCount: 6 },
    web: { cpu: 512, memoryMiB: 1024, minCount: 2, maxCount: 4 },
    worker: { cpu: 1024, memoryMiB: 2048, minCount: 1, maxCount: 4 },
  },
};

/** How the public endpoints are exposed, derived from the domain settings. */
export type EdgeMode =
  /** No domain: HTTP on the ALB DNS name, API paths routed by path. Dashboard sign-in is unavailable (Cognito needs HTTPS callbacks). */
  | { kind: 'alb-dns' }
  /** Domain: HTTPS with host-based routing; DNS records automated when a hosted zone is given. */
  | {
      kind: 'domain';
      domainName: string;
      apiHostname: string;
      webHostname: string;
      certificateArn?: string;
      hostedZone?: { id: string; name: string };
    };

export interface EnvConfig extends EnvSettings {
  envName: EnvName;
  slug: string;
  region: string;
  imageTag: string;
  edge: EdgeMode;
  names: ReturnType<typeof resourceNames>;
}

export interface GithubConfig {
  repo: string;
  envs: EnvName[];
  oidcProviderArn?: string;
  cdkQualifier: string;
  /** Region of the GitHub deploy stack itself (IAM is global; the stack needs one). */
  region: string;
  /** Region each environment is deployed to: its role may act only there. */
  envRegions: Record<EnvName, string>;
}

export class ConfigError extends Error {}

/** Physical names shared between stacks, the deploy role policy and the pipeline. */
export function resourceNames(slug: string, envName: EnvName) {
  const prefix = `${slug}-${envName}`;
  const pascal = prefix
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
  return {
    prefix,
    /** PascalCase prefix for metric names, e.g. LodgentDev. */
    pascal,
    /** CloudFormation export name the deploy pipeline looks up, e.g. lodgent-dev-ClusterName. */
    exportName: (output: string) => `${prefix}-${output}`,
    stack: (part: 'network' | 'data' | 'platform' | 'services') => `${prefix}-${part}`,
    cluster: prefix,
    repository: (service: 'api' | 'worker' | 'web') => `${prefix}-${service}`,
    appSecret: `${slug}/${envName}/app`,
    migrateFamily: `${prefix}-migrate`,
    migrateExecutionRole: `${prefix}-migrate-execution`,
    migrateTaskRole: `${prefix}-migrate-task`,
    logGroup: (name: string) => `/${slug}/${envName}/${name}`,
    databaseName: slug.replace(/[^a-z0-9_]/g, '_'),
    databaseUser: `${slug.replace(/[^a-z0-9_]/g, '_')}_admin`,
    dbInstanceIdentifier: `${prefix}-db`,
    scheduleGroup: prefix,
    serviceDiscoveryNamespace: `${prefix}.internal`,
  };
}

function rawContext(node: Node, envName: EnvName, key: string): unknown {
  const flat = node.tryGetContext(`${envName}.${key}`);
  if (flat !== undefined) return flat;
  const environments: unknown = node.tryGetContext('environments');
  if (environments && typeof environments === 'object') {
    const env = (environments as Record<string, unknown>)[envName];
    if (env && typeof env === 'object') return (env as Record<string, unknown>)[key];
  }
  return undefined;
}

function contextString(node: Node, key: string): string | undefined {
  const value: unknown = node.tryGetContext(key);
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function formatIssues(error: z.ZodError, label: string): string {
  return `Invalid CDK context for ${label}: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
}

export function loadEnvConfig(node: Node, envName: EnvName): EnvConfig {
  const defaults = ENV_DEFAULTS[envName];
  const input: Record<string, unknown> = {};
  for (const key of Object.keys(EnvSettings.shape) as (keyof EnvSettings)[]) {
    const fallback = defaults[key];
    if (key === 'api' || key === 'web' || key === 'worker') {
      const size = fallback as ServiceSize;
      input[key] = Object.fromEntries(
        (Object.keys(size) as (keyof ServiceSize)[]).map((field) => [
          field,
          rawContext(node, envName, `${key}.${field}`) ??
            (rawContext(node, envName, key) as Partial<ServiceSize> | undefined)?.[field] ??
            size[field],
        ]),
      );
    } else {
      input[key] = rawContext(node, envName, key) ?? fallback;
    }
  }
  const parsed = EnvSettings.safeParse(input);
  if (!parsed.success) throw new ConfigError(formatIssues(parsed.error, envName));
  const settings = parsed.data;
  for (const service of ['api', 'web', 'worker'] as const) {
    if (settings[service].minCount > settings[service].maxCount)
      throw new ConfigError(`${envName}.${service}: minCount exceeds maxCount`);
  }
  if (settings.dbMaxAllocatedStorageGiB < settings.dbAllocatedStorageGiB)
    throw new ConfigError(`${envName}: dbMaxAllocatedStorageGiB must be >= dbAllocatedStorageGiB`);

  const slug = BRAND.slug;
  return {
    ...settings,
    envName,
    slug,
    region: envRegion(node, envName),
    imageTag: imageTag(node),
    edge: edgeMode(settings, envName),
    names: resourceNames(slug, envName),
  };
}

function envRegion(node: Node, envName: EnvName): string {
  const value = rawContext(node, envName, 'region');
  const region =
    (typeof value === 'string' && value.trim()) || contextString(node, 'region') || DEFAULT_REGION;
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region))
    throw new ConfigError(`region "${region}" is not an AWS region`);
  return region;
}

/** Tag used when no `imageTag` context is given, so `cdk synth` works without one. */
export const DEFAULT_IMAGE_TAG = 'latest';

function imageTag(node: Node): string {
  const tag = contextString(node, 'imageTag') ?? DEFAULT_IMAGE_TAG;
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag))
    throw new ConfigError(`imageTag "${tag}" is not a valid tag`);
  return tag;
}

function edgeMode(settings: EnvSettings, envName: EnvName): EdgeMode {
  const { domainName } = settings;
  if (!domainName) {
    for (const key of ['hostedZoneId', 'certificateArn', 'apiHostname', 'webHostname'] as const) {
      if (settings[key]) throw new ConfigError(`${envName}.${key} needs ${envName}.domainName`);
    }
    return { kind: 'alb-dns' };
  }
  const zoneName = settings.hostedZoneName ?? domainName;
  if (settings.hostedZoneName && !settings.hostedZoneId)
    throw new ConfigError(`${envName}.hostedZoneName needs ${envName}.hostedZoneId`);
  const apiHostname = settings.apiHostname ?? `api.${domainName}`;
  const webHostname = settings.webHostname ?? `app.${domainName}`;
  if (settings.hostedZoneId) {
    for (const host of [domainName, apiHostname, webHostname]) {
      if (host !== zoneName && !host.endsWith(`.${zoneName}`))
        throw new ConfigError(`${envName}: ${host} is not inside the hosted zone ${zoneName}`);
    }
  }
  return {
    kind: 'domain',
    domainName,
    apiHostname,
    webHostname,
    certificateArn: settings.certificateArn,
    hostedZone: settings.hostedZoneId ? { id: settings.hostedZoneId, name: zoneName } : undefined,
  };
}

/** All environments, or only the one in the `env` context (the deploy pipeline passes `-c env=<env>`). */
export function selectedEnvironments(node: Node): readonly EnvName[] {
  const only = contextString(node, 'env');
  if (only === undefined) return ENV_NAMES;
  const parsed = z.enum(ENV_NAMES).safeParse(only);
  if (!parsed.success) throw new ConfigError(`env "${only}" must be one of ${ENV_NAMES.join(', ')}`);
  return [parsed.data];
}

export function loadGithubConfig(node: Node): GithubConfig {
  const Schema = z.object({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be owner/repo'),
    envs: z.array(z.enum(ENV_NAMES)).min(1),
    oidcProviderArn: z.string().startsWith('arn:').optional(),
    cdkQualifier: z.string().regex(/^[a-z0-9]{1,10}$/),
    region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'must be an AWS region'),
  });
  const parsed = Schema.safeParse({
    repo: contextString(node, 'githubRepo') ?? DEFAULT_GITHUB_REPO,
    envs: (contextString(node, 'githubDeployEnvs') ?? ENV_NAMES.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    oidcProviderArn: contextString(node, 'githubOidcProviderArn'),
    cdkQualifier: contextString(node, 'cdkQualifier') ?? 'hnb659fds',
    region: contextString(node, 'region') ?? DEFAULT_REGION,
  });
  if (!parsed.success) throw new ConfigError(formatIssues(parsed.error, 'github'));
  const envRegions = Object.fromEntries(ENV_NAMES.map((env) => [env, envRegion(node, env)])) as Record<
    EnvName,
    string
  >;
  return { ...parsed.data, envRegions };
}
