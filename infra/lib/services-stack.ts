import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as appscaling from 'aws-cdk-lib/aws-applicationautoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import type { Construct } from 'constructs';
import type { EnvConfig, ServiceSize } from './config';
import { APP_SECRET_KEYS, type AppSecretKey, type DataStack } from './data-stack';
import { API_PORT, type NetworkStack, WEB_PORT } from './network-stack';
import type { PlatformStack } from './platform-stack';
import {
  type AppService,
  addTelemetrySidecar,
  allowSecretDecryption,
  appLogDriver,
  appSecrets,
  databaseEnvironment,
  databaseSecrets,
  OTLP_ENDPOINT,
  otelServiceName,
  runtimePlatform,
} from './runtime';

/** App secret keys the web server needs; the api and worker get all the others. */
export const WEB_SECRET_KEYS: readonly AppSecretKey[] = ['COGNITO_CLIENT_SECRET'];
export const API_WORKER_SECRET_KEYS: readonly AppSecretKey[] = APP_SECRET_KEYS.filter(
  (key) => !WEB_SECRET_KEYS.includes(key),
);

/** Production endpoints of Apaleo (the app's defaults point at the local fake server). */
const APALEO_ENDPOINTS = {
  APALEO_IDENTITY_URL: 'https://identity.apaleo.com',
  APALEO_API_URL: 'https://api.apaleo.com',
  APALEO_WEBHOOK_URL: 'https://webhook.apaleo.com',
};

export interface ServicesStackProps extends StackProps {
  config: EnvConfig;
  network: NetworkStack;
  data: DataStack;
  platform: PlatformStack;
}

/**
 * The three long-running services (api, worker, web) with their task definitions, autoscaling,
 * service alarms and the dashboard. Deployed last, after the migration task has run with the same
 * image tag.
 */
export class ServicesStack extends Stack {
  readonly services: Record<AppService, ecs.FargateService>;
  readonly taskDefinitions: Record<AppService, ecs.FargateTaskDefinition>;
  readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: ServicesStackProps) {
    super(scope, id, props);
    const { config, network, data, platform } = props;
    const { names } = config;
    const sgs = network.securityGroups;
    const { edge } = platform;

    const forbidden = Object.keys(config.appEnvironment).filter(
      (key) => (APP_SECRET_KEYS as readonly string[]).includes(key) || key.startsWith('DATABASE_'),
    );
    if (forbidden.length > 0)
      throw new Error(
        `${config.envName}.appEnvironment must not set ${forbidden.join(', ')} (secrets/database)`,
      );

    const appEnvironment = (service: 'api' | 'worker'): Record<string, string> => ({
      APP_ENV: 'production',
      LOG_LEVEL: 'info',
      WEB_BASE_URL: edge.webBaseUrl,
      API_BASE_URL: edge.apiBaseUrl,
      API_PORT: String(API_PORT),
      AUTH_PROVIDER: 'cognito',
      COGNITO_USER_POOL_ID: data.userPool.userPoolId,
      COGNITO_CLIENT_ID: data.userPoolClient.userPoolClientId,
      COGNITO_DOMAIN: data.cognitoDomain,
      AWS_REGION: config.region,
      KMS_PROVIDER: 'aws',
      KMS_KEY_ID: data.appKey.keyArn,
      QUEUE_PROVIDER: 'sqs',
      SQS_QUEUE_URL: data.jobsQueue.queueUrl,
      EMAIL_PROVIDER: 'ses',
      EMAIL_FROM: data.email.from,
      ...APALEO_ENDPOINTS,
      ...databaseEnvironment(config, data),
      OTEL_EXPORTER_OTLP_ENDPOINT: OTLP_ENDPOINT,
      OTEL_SERVICE_NAME: otelServiceName(config, service),
      ...config.appEnvironment,
    });

    const taskDefinition = (service: AppService, size: ServiceSize, volumes: ecs.Volume[] = []) =>
      new ecs.FargateTaskDefinition(this, `${title(service)}TaskDefinition`, {
        family: `${names.prefix}-${service}`,
        cpu: size.cpu,
        memoryLimitMiB: size.memoryMiB,
        runtimePlatform: runtimePlatform(config),
        volumes,
      });
    const image = (service: AppService) =>
      ecs.ContainerImage.fromEcrRepository(data.repositories[service], config.imageTag);

    // ---- api -------------------------------------------------------------------------------------
    const apiTask = taskDefinition('api', config.api, [{ name: 'tmp' }]);
    const api = apiTask.addContainer('api', {
      image: image('api'),
      environment: appEnvironment('api'),
      secrets: { ...databaseSecrets(this, data), ...appSecrets(this, data, API_WORKER_SECRET_KEYS) },
      portMappings: [{ containerPort: API_PORT, name: 'http', appProtocol: ecs.AppProtocol.http }],
      logging: appLogDriver(platform.logGroups.api, 'api'),
      readonlyRootFilesystem: true,
      stopTimeout: Duration.seconds(30),
    });
    api.addMountPoints({ sourceVolume: 'tmp', containerPath: '/tmp', readOnly: false });
    addTelemetrySidecar(config, apiTask, api, platform.logGroups.api);
    this.grantAppAccess(apiTask.taskRole, data, { sendJobs: true, receiveJobs: false, sendEmail: false });

    // ---- worker ----------------------------------------------------------------------------------
    const workerTask = taskDefinition('worker', config.worker, [{ name: 'tmp' }]);
    const worker = workerTask.addContainer('worker', {
      image: image('worker'),
      environment: appEnvironment('worker'),
      secrets: { ...databaseSecrets(this, data), ...appSecrets(this, data, API_WORKER_SECRET_KEYS) },
      logging: appLogDriver(platform.logGroups.worker, 'worker'),
      readonlyRootFilesystem: true,
      // Lets a running job finish (SQS long poll is 20 s); unfinished jobs are redelivered.
      stopTimeout: Duration.seconds(120),
    });
    worker.addMountPoints({ sourceVolume: 'tmp', containerPath: '/tmp', readOnly: false });
    addTelemetrySidecar(config, workerTask, worker, platform.logGroups.worker);
    this.grantAppAccess(workerTask.taskRole, data, { sendJobs: true, receiveJobs: true, sendEmail: true });

    // ---- web -------------------------------------------------------------------------------------
    const webTask = taskDefinition('web', config.web);
    webTask.addContainer('web', {
      image: image('web'),
      environment: {
        APP_ENV: 'production',
        LOG_LEVEL: 'info',
        PORT: String(WEB_PORT),
        // Next.js standalone binds to HOSTNAME; the platform would otherwise set it to the task's name.
        HOSTNAME: '0.0.0.0',
        WEB_BASE_URL: edge.webBaseUrl,
        API_BASE_URL: edge.apiBaseUrl,
        // Server-side calls go straight to the api tasks (Cloud Map), not through the ALB and WAF.
        API_INTERNAL_URL: `http://api.${names.serviceDiscoveryNamespace}:${API_PORT}`,
        AUTH_PROVIDER: 'cognito',
        COGNITO_DOMAIN: data.cognitoDomain,
        COGNITO_CLIENT_ID: data.userPoolClient.userPoolClientId,
        AWS_REGION: config.region,
        OTEL_SERVICE_NAME: otelServiceName(config, 'web'),
      },
      secrets: appSecrets(this, data, WEB_SECRET_KEYS),
      portMappings: [{ containerPort: WEB_PORT, name: 'http', appProtocol: ecs.AppProtocol.http }],
      logging: appLogDriver(platform.logGroups.web, 'web'),
      // Next.js writes its cache under .next/cache, so the root filesystem stays writable here.
      readonlyRootFilesystem: false,
      stopTimeout: Duration.seconds(30),
    });

    this.taskDefinitions = { api: apiTask, worker: workerTask, web: webTask };
    for (const task of Object.values(this.taskDefinitions)) allowSecretDecryption(task, data, config.region);

    // ---- services --------------------------------------------------------------------------------
    const service = (
      name: AppService,
      task: ecs.FargateTaskDefinition,
      securityGroup: ec2.ISecurityGroup,
      size: ServiceSize,
      extra: Partial<ecs.FargateServiceProps> = {},
    ) =>
      new ecs.FargateService(this, `${title(name)}Service`, {
        cluster: platform.cluster,
        taskDefinition: task,
        // Left to autoscaling after creation (only an explicit 0 is pinned, for bootstrapping).
        desiredCount: size.minCount === 0 ? 0 : undefined,
        securityGroups: [securityGroup],
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        assignPublicIp: false,
        circuitBreaker: { enable: true, rollback: true },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        enableExecuteCommand: config.enableExecuteCommand,
        propagateTags: ecs.PropagatedTagSource.SERVICE,
        enableECSManagedTags: true,
        capacityProviderStrategies: [
          { capacityProvider: config.fargateSpot ? 'FARGATE_SPOT' : 'FARGATE', weight: 1 },
        ],
        ...extra,
      });

    const apiService = service('api', apiTask, sgs.api, config.api, {
      healthCheckGracePeriod: Duration.seconds(60),
      cloudMapOptions: {
        name: 'api',
        cloudMapNamespace: platform.namespace,
        dnsRecordType: servicediscovery.DnsRecordType.A,
        dnsTtl: Duration.seconds(10),
        container: api,
        containerPort: API_PORT,
      },
    });
    apiService.attachToApplicationTargetGroup(edge.apiTargetGroup);

    const workerService = service('worker', workerTask, sgs.worker, config.worker);

    const webService = service('web', webTask, sgs.web, config.web, {
      healthCheckGracePeriod: Duration.seconds(60),
    });
    webService.attachToApplicationTargetGroup(edge.webTargetGroup);

    this.services = { api: apiService, worker: workerService, web: webService };

    // ---- autoscaling -----------------------------------------------------------------------------
    for (const [name, svc, size, targetGroup, requestsPerTarget] of [
      ['api', apiService, config.api, edge.apiTargetGroup, 1000],
      ['web', webService, config.web, edge.webTargetGroup, 600],
    ] as const) {
      const scaling = svc.autoScaleTaskCount({ minCapacity: size.minCount, maxCapacity: size.maxCount });
      scaling.scaleOnCpuUtilization(`${title(name)}CpuScaling`, {
        targetUtilizationPercent: 60,
        scaleInCooldown: Duration.minutes(5),
        scaleOutCooldown: Duration.minutes(1),
      });
      scaling.scaleOnRequestCount(`${title(name)}RequestScaling`, {
        requestsPerTarget,
        targetGroup,
        scaleInCooldown: Duration.minutes(5),
        scaleOutCooldown: Duration.minutes(1),
      });
    }
    const workerScaling = workerService.autoScaleTaskCount({
      minCapacity: config.worker.minCount,
      maxCapacity: config.worker.maxCount,
    });
    // Queue depth drives the worker in both directions; CPU may only add capacity (no flapping).
    workerScaling.scaleOnMetric('WorkerQueueDepthScaling', {
      metric: data.jobsQueue.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(1),
        statistic: 'Maximum',
      }),
      scalingSteps: [
        { upper: 10, change: -1 },
        { lower: 100, change: +1 },
        { lower: 500, change: +2 },
      ],
      adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: Duration.minutes(3),
      evaluationPeriods: 3,
    });
    workerScaling.scaleOnCpuUtilization('WorkerCpuScaling', {
      targetUtilizationPercent: 70,
      disableScaleIn: true,
      scaleOutCooldown: Duration.minutes(2),
    });

    this.createAlarms(config, platform);
    this.createDashboard(config, data, platform);

    for (const [name, svc] of Object.entries(this.services)) {
      const outputName = `${title(name)}ServiceName`;
      new CfnOutput(this, outputName, {
        value: svc.serviceName,
        description: `ECS service running the ${name} image`,
        exportName: names.exportName(outputName),
      });
    }
  }

  /** Least-privilege app permissions for the api and worker task roles. */
  private grantAppAccess(
    role: iam.IRole,
    data: DataStack,
    access: { sendJobs: boolean; receiveJobs: boolean; sendEmail: boolean },
  ): void {
    // Envelope encryption of integration tokens (GenerateDataKey to seal, Decrypt to open).
    data.appKey.grant(role, 'kms:GenerateDataKey', 'kms:Decrypt');
    if (access.sendJobs) data.jobsQueue.grantSendMessages(role);
    if (access.receiveJobs) data.jobsQueue.grantConsumeMessages(role);
    if (access.sendEmail) {
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'SendEmail',
          actions: ['ses:SendEmail', 'ses:SendRawEmail'],
          resources: data.email.sendResources,
        }),
      );
    }
  }

  private createAlarms(config: EnvConfig, platform: PlatformStack): void {
    const action = new cwActions.SnsAction(platform.alarmTopic);
    for (const [name, svc] of Object.entries(this.services)) {
      const alarms = [
        new cloudwatch.Alarm(this, `${title(name)}CpuAlarm`, {
          alarmName: `${config.names.prefix}-${name}-cpu`,
          alarmDescription: `${name} CPU above 85% for 15 minutes (autoscaling at its maximum?).`,
          metric: svc.metricCpuUtilization({ period: Duration.minutes(5) }),
          threshold: 85,
          evaluationPeriods: 3,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
        new cloudwatch.Alarm(this, `${title(name)}MemoryAlarm`, {
          alarmName: `${config.names.prefix}-${name}-memory`,
          alarmDescription: `${name} memory above 85% for 15 minutes.`,
          metric: svc.metricMemoryUtilization({ period: Duration.minutes(5) }),
          threshold: 85,
          evaluationPeriods: 3,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        }),
        new cloudwatch.Alarm(this, `${title(name)}NoRunningTasksAlarm`, {
          alarmName: `${config.names.prefix}-${name}-no-running-tasks`,
          alarmDescription: `${name} has had no running task for 10 minutes.`,
          metric: new cloudwatch.Metric({
            namespace: 'ECS/ContainerInsights',
            metricName: 'RunningTaskCount',
            dimensionsMap: { ClusterName: platform.cluster.clusterName, ServiceName: svc.serviceName },
            statistic: 'Minimum',
            period: Duration.minutes(5),
          }),
          threshold: 1,
          evaluationPeriods: 2,
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        }),
      ];
      for (const alarm of alarms) {
        alarm.addAlarmAction(action);
        alarm.addOkAction(action);
        this.alarms.push(alarm);
      }
    }
  }

  private createDashboard(config: EnvConfig, data: DataStack, platform: PlatformStack): void {
    const { edge } = platform;
    const alb = edge.loadBalancer;
    const period = Duration.minutes(5);
    const perService = (metric: (svc: ecs.FargateService) => cloudwatch.Metric) =>
      Object.entries(this.services).map(([name, svc]) => metric(svc).with({ label: name, period }));
    const db = data.database;

    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: config.names.prefix,
      defaultInterval: Duration.hours(6),
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'Requests and errors (ALB)',
            left: [alb.metrics.requestCount({ period, label: 'requests' })],
            right: [
              alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
                period,
                label: 'target 5xx',
              }),
              alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period, label: 'ALB 5xx' }),
              alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_4XX_COUNT, {
                period,
                label: 'target 4xx',
              }),
            ],
            width: 12,
          }),
          new cloudwatch.GraphWidget({
            title: 'Target response time p95 (s)',
            left: [
              edge.apiTargetGroup.metrics.targetResponseTime({ statistic: 'p95', period, label: 'api' }),
              edge.webTargetGroup.metrics.targetResponseTime({ statistic: 'p95', period, label: 'web' }),
            ],
            width: 12,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'ECS CPU %',
            left: perService((svc) => svc.metricCpuUtilization()),
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: 'ECS memory %',
            left: perService((svc) => svc.metricMemoryUtilization()),
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: 'Running tasks',
            left: Object.entries(this.services).map(
              ([name, svc]) =>
                new cloudwatch.Metric({
                  namespace: 'ECS/ContainerInsights',
                  metricName: 'RunningTaskCount',
                  dimensionsMap: { ClusterName: platform.cluster.clusterName, ServiceName: svc.serviceName },
                  statistic: 'Average',
                  period,
                  label: name,
                }),
            ),
            width: 8,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'Database CPU % and connections',
            left: [db.metricCPUUtilization({ period, label: 'CPU %' })],
            right: [db.metricDatabaseConnections({ period, label: 'connections' })],
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: 'Database free storage (bytes) and memory',
            left: [db.metricFreeStorageSpace({ period, label: 'free storage' })],
            right: [db.metricFreeableMemory({ period, label: 'freeable memory' })],
            width: 8,
          }),
          new cloudwatch.GraphWidget({
            title: 'Jobs queue',
            left: [
              data.jobsQueue.metricApproximateNumberOfMessagesVisible({ period, label: 'visible' }),
              data.jobsDeadLetterQueue.metricApproximateNumberOfMessagesVisible({
                period,
                label: 'dead-letter',
              }),
            ],
            right: [data.jobsQueue.metricApproximateAgeOfOldestMessage({ period, label: 'oldest age (s)' })],
            width: 8,
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: 'WAF blocked requests',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/WAFV2',
                metricName: 'BlockedRequests',
                dimensionsMap: { WebACL: `${config.names.prefix}-alb`, Region: config.region, Rule: 'ALL' },
                statistic: 'Sum',
                period,
                label: 'blocked',
              }),
            ],
            width: 12,
          }),
          new cloudwatch.AlarmStatusWidget({
            title: 'Alarms',
            alarms: [...platform.alarms, ...this.alarms],
            width: 12,
            height: 8,
          }),
        ],
      ],
    });
  }
}

function title(name: string): string {
  return `${name[0]!.toUpperCase()}${name.slice(1)}`;
}
