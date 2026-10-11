import { Size, Stack } from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config';
import { APP_SECRET_KEYS, type AppSecretKey, type DataStack } from './data-stack';

/** AWS Distro for OpenTelemetry collector, pinned (public ECR). */
export const ADOT_COLLECTOR_IMAGE = 'public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0';
/** Where the apps send OTLP/HTTP traces: the collector sidecar in the same task (shared network namespace). */
export const OTLP_ENDPOINT = 'http://localhost:4318';

export type AppService = 'api' | 'worker' | 'web';

/** OpenTelemetry service names (OTEL_SERVICE_NAME). */
export function otelServiceName(config: EnvConfig, service: AppService): string {
  return `${config.slug}-${service}`;
}

export function runtimePlatform(config: EnvConfig): ecs.RuntimePlatform {
  return {
    operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
    cpuArchitecture:
      config.cpuArchitecture === 'arm64' ? ecs.CpuArchitecture.ARM64 : ecs.CpuArchitecture.X86_64,
  };
}

export function appLogDriver(logGroup: logs.ILogGroup, streamPrefix: string): ecs.LogDriver {
  return ecs.LogDrivers.awsLogs({
    logGroup,
    streamPrefix,
    // Never block the app on CloudWatch Logs back-pressure; buffer up to 25 MiB instead.
    mode: ecs.AwsLogDriverMode.NON_BLOCKING,
    maxBufferSize: Size.mebibytes(25),
  });
}

/** Plain environment for PostgreSQL; the credentials come from the RDS secret (see databaseSecrets). */
export function databaseEnvironment(config: EnvConfig, data: DataStack): Record<string, string> {
  return {
    DATABASE_HOST: data.database.dbInstanceEndpointAddress,
    DATABASE_PORT: data.database.dbInstanceEndpointPort,
    DATABASE_NAME: config.names.databaseName,
    DATABASE_SSL: 'true',
  };
}

/**
 * A data-stack secret as seen from a consuming stack, without its KMS key. Granting read on the
 * owned secret would also add the execution role to the data key's policy, a reference back from
 * the data stack to the consumer (a dependency cycle). Decryption is granted on the role instead,
 * by allowSecretDecryption.
 */
function secretRef(scope: Construct, id: string, secretArn: string): secretsmanager.ISecret {
  const stack = Stack.of(scope);
  const existing = stack.node.tryFindChild(id);
  return (
    (existing as secretsmanager.ISecret | undefined) ??
    secretsmanager.Secret.fromSecretCompleteArn(stack, id, secretArn)
  );
}

export function databaseSecrets(scope: Construct, data: DataStack): Record<string, ecs.Secret> {
  const secret = secretRef(scope, 'DatabaseSecretRef', data.databaseSecret.secretArn);
  return {
    DATABASE_USER: ecs.Secret.fromSecretsManager(secret, 'username'),
    DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(secret, 'password'),
  };
}

export function appSecrets(
  scope: Construct,
  data: DataStack,
  keys: readonly AppSecretKey[] = APP_SECRET_KEYS,
): Record<string, ecs.Secret> {
  const secret = secretRef(scope, 'AppSecretRef', data.appSecret.secretArn);
  return Object.fromEntries(keys.map((key) => [key, ecs.Secret.fromSecretsManager(secret, key)]));
}

/** Lets the task's execution role decrypt the data key, only through Secrets Manager. */
export function allowSecretDecryption(
  taskDefinition: ecs.TaskDefinition,
  data: DataStack,
  region: string,
): void {
  taskDefinition.obtainExecutionRole().addToPrincipalPolicy(
    new iam.PolicyStatement({
      sid: 'DecryptSecretsViaSecretsManager',
      actions: ['kms:Decrypt'],
      resources: [data.dataKey.keyArn],
      conditions: { StringEquals: { 'kms:ViaService': `secretsmanager.${region}.amazonaws.com` } },
    }),
  );
}

/**
 * Collector config, passed inline through AOT_CONFIG_CONTENT: OTLP/HTTP in on localhost only,
 * traces out to AWS X-Ray, with ECS resource attributes. Logs stay on stdout (CloudWatch Logs).
 */
export function collectorConfig(region: string): string {
  return [
    'extensions:',
    '  health_check:',
    '    endpoint: 127.0.0.1:13133',
    'receivers:',
    '  otlp:',
    '    protocols:',
    '      http:',
    '        endpoint: 127.0.0.1:4318',
    'processors:',
    '  memory_limiter:',
    '    check_interval: 1s',
    '    limit_percentage: 80',
    '    spike_limit_percentage: 25',
    '  resourcedetection:',
    '    detectors: [env, ecs]',
    '    timeout: 2s',
    '    override: false',
    '  batch/traces:',
    '    timeout: 1s',
    '    send_batch_size: 50',
    'exporters:',
    '  awsxray:',
    `    region: ${region}`,
    'service:',
    '  extensions: [health_check]',
    '  pipelines:',
    '    traces:',
    '      receivers: [otlp]',
    '      processors: [memory_limiter, resourcedetection, batch/traces]',
    '      exporters: [awsxray]',
    '',
  ].join('\n');
}

/**
 * Adds the ADOT collector sidecar (non-essential: if it dies, the app keeps running without traces)
 * and the X-Ray permissions it needs to the task role. The app container starts after it.
 */
export function addTelemetrySidecar(
  config: EnvConfig,
  taskDefinition: ecs.TaskDefinition,
  app: ecs.ContainerDefinition,
  logGroup: logs.ILogGroup,
): ecs.ContainerDefinition {
  const collector = taskDefinition.addContainer('otel-collector', {
    image: ecs.ContainerImage.fromRegistry(ADOT_COLLECTOR_IMAGE),
    essential: false,
    memoryReservationMiB: 64,
    memoryLimitMiB: 256,
    environment: { AOT_CONFIG_CONTENT: collectorConfig(config.region) },
    logging: appLogDriver(logGroup, 'otel-collector'),
  });
  app.addContainerDependencies({ container: collector, condition: ecs.ContainerDependencyCondition.START });
  taskDefinition.addToTaskRolePolicy(
    new iam.PolicyStatement({
      sid: 'XRayWrite',
      // X-Ray has no resource-level permissions for these actions.
      actions: [
        'xray:PutTraceSegments',
        'xray:PutTelemetryRecords',
        'xray:GetSamplingRules',
        'xray:GetSamplingTargets',
        'xray:GetSamplingStatisticSummaries',
      ],
      resources: ['*'],
    }),
  );
  return collector;
}
