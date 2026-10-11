import { SCHEDULES, type Schedule } from '@lodgent/shared';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config';
import type { DataStack } from './data-stack';
import { Edge } from './edge';
import type { NetworkStack } from './network-stack';
import {
  APP_CONTAINER_USER,
  type AppService,
  allowSecretDecryption,
  appLogDriver,
  databaseEnvironment,
  databaseSecrets,
  runtimePlatform,
} from './runtime';

export const MIGRATE_COMMAND = ['node', 'apps/api/dist/migrate.js'];
export const MIGRATE_CONTAINER = 'migrate';

/**
 * The SQS message a schedule sends. Matches what SqsJobQueue enqueues and SqsJobConsumer parses
 * (packages/application): `{ type, payload, dedupeKey? }` as a JSON string.
 */
export function scheduledJobMessage(schedule: Schedule): {
  type: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
} {
  return {
    type: schedule.job.type,
    payload: schedule.job.payload,
    dedupeKey: `schedule:${schedule.name}:${scheduler.ContextAttribute.scheduledTime}`,
  };
}

export interface PlatformStackProps extends StackProps {
  config: EnvConfig;
  network: NetworkStack;
  data: DataStack;
}

/**
 * Everything the services run on, deployed (with the new image tag) before the migration runs and
 * before the services roll: ECS cluster and service discovery, log groups, load balancer and WAF,
 * the one-off migration task definition, EventBridge schedules and the alarm topic with the
 * load balancer, database and queue alarms.
 */
export class PlatformStack extends Stack {
  readonly cluster: ecs.Cluster;
  readonly namespace: servicediscovery.INamespace;
  readonly edge: Edge;
  readonly logGroups: Record<AppService | 'migrate', logs.LogGroup>;
  readonly migrateTaskDefinition: ecs.FargateTaskDefinition;
  readonly alarmTopic: sns.Topic;
  readonly scheduleGroup: scheduler.ScheduleGroup;
  /** Alarms defined here (load balancer, database, queue), for the dashboard. */
  readonly alarms: cloudwatch.Alarm[] = [];

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    const { config, network, data } = props;
    const { names } = config;
    const { exportName } = names;
    const removalPolicy = config.protectData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: names.cluster,
      vpc: network.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true,
    });
    this.namespace = this.cluster.addDefaultCloudMapNamespace({
      name: names.serviceDiscoveryNamespace,
      type: servicediscovery.NamespaceType.DNS_PRIVATE,
      vpc: network.vpc,
    });

    const logGroup = (name: AppService | 'migrate') =>
      new logs.LogGroup(this, `${name[0]!.toUpperCase()}${name.slice(1)}LogGroup`, {
        logGroupName: names.logGroup(name),
        retention: config.logRetentionDays,
        removalPolicy,
      });
    this.logGroups = {
      api: logGroup('api'),
      worker: logGroup('worker'),
      web: logGroup('web'),
      migrate: logGroup('migrate'),
    };

    this.edge = new Edge(this, 'Edge', { config, vpc: network.vpc, securityGroups: network.securityGroups });

    // ---- One-off migration task (api image) ---------------------------------------------------
    // Named roles so the GitHub deploy role can pass exactly these two to ecs:RunTask.
    const migrateExecutionRole = new iam.Role(this, 'MigrateExecutionRole', {
      roleName: names.migrateExecutionRole,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `${names.prefix}: pulls the api image and reads the database secret for migrations`,
    });
    const migrateTaskRole = new iam.Role(this, 'MigrateTaskRole', {
      roleName: names.migrateTaskRole,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `${names.prefix}: migration task (no AWS permissions needed)`,
    });
    this.migrateTaskDefinition = new ecs.FargateTaskDefinition(this, 'MigrateTaskDefinition', {
      family: names.migrateFamily,
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: runtimePlatform(config),
      executionRole: migrateExecutionRole,
      taskRole: migrateTaskRole,
      volumes: [{ name: 'tmp' }],
    });
    const migrate = this.migrateTaskDefinition.addContainer(MIGRATE_CONTAINER, {
      image: ecs.ContainerImage.fromEcrRepository(data.repositories.api, config.imageTag),
      command: MIGRATE_COMMAND,
      // Migrations need only the database; the app secret is not mounted.
      environment: { APP_ENV: 'production', LOG_LEVEL: 'info', ...databaseEnvironment(config, data) },
      secrets: databaseSecrets(this, data),
      logging: appLogDriver(this.logGroups.migrate, 'migrate'),
      user: APP_CONTAINER_USER,
      readonlyRootFilesystem: true,
    });
    migrate.addMountPoints({ sourceVolume: 'tmp', containerPath: '/tmp', readOnly: false });
    allowSecretDecryption(this.migrateTaskDefinition, data, config.region);

    // ---- Schedules → jobs queue ------------------------------------------------------------------
    this.scheduleGroup = new scheduler.ScheduleGroup(this, 'ScheduleGroup', {
      scheduleGroupName: names.scheduleGroup,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      description: `${names.prefix}: EventBridge Scheduler sends scheduled jobs to SQS`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': this.formatArn({
              service: 'scheduler',
              resource: 'schedule',
              resourceName: `${names.scheduleGroup}/*`,
            }),
          },
        },
      }),
    });
    for (const schedule of SCHEDULES) {
      new scheduler.Schedule(this, `Schedule-${schedule.name}`, {
        scheduleName: schedule.name,
        scheduleGroup: this.scheduleGroup,
        description: `Enqueue ${schedule.job.type}`,
        schedule: scheduler.ScheduleExpression.expression(schedule.expression),
        target: new schedulerTargets.SqsSendMessage(data.jobsQueue, {
          role: schedulerRole,
          input: scheduler.ScheduleTargetInput.fromObject(scheduledJobMessage(schedule)),
          // A run older than one interval is superseded by the next one.
          maxEventAge: Duration.seconds(Math.min(Math.max(schedule.everyMinutes * 60, 60), 86_400)),
          retryAttempts: 10,
          // Undeliverable runs land in the jobs DLQ (alarmed), from where they can be redriven.
          deadLetterQueue: data.jobsDeadLetterQueue,
        }),
      });
    }

    // ---- Alarms -------------------------------------------------------------------------------
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${names.prefix}-alarms`,
      displayName: `${names.prefix} alarms`,
      enforceSSL: true,
    });
    if (config.alarmEmail)
      this.alarmTopic.addSubscription(new subscriptions.EmailSubscription(config.alarmEmail));
    this.createAlarms(config, data);

    // ---- Outputs ------------------------------------------------------------------------------
    const outputs: [string, string, string][] = [
      ['ClusterName', this.cluster.clusterName, 'ECS cluster for services and one-off tasks'],
      [
        'MigrateTaskDefinitionArn',
        this.migrateTaskDefinition.taskDefinitionArn,
        `Run before deploying the services: aws ecs run-task --launch-type FARGATE --task-definition <this> (container "${MIGRATE_CONTAINER}")`,
      ],
      ['MigrateTaskFamily', names.migrateFamily, 'Task definition family of the migration task'],
      ['MigrateLogGroupName', this.logGroups.migrate.logGroupName, 'Migration task logs'],
      ['LoadBalancerDnsName', this.edge.loadBalancer.loadBalancerDnsName, 'Point DNS (CNAME/alias) here'],
      ['WebUrl', this.edge.webBaseUrl, 'Public base URL of the web app (WEB_BASE_URL)'],
      ['ApiUrl', this.edge.apiBaseUrl, 'Public base URL of the API (API_BASE_URL; MCP at /mcp)'],
      ['AlarmTopicArn', this.alarmTopic.topicArn, 'SNS topic for CloudWatch alarms'],
    ];
    for (const [name, value, description] of outputs) {
      new CfnOutput(this, name, { value, description, exportName: exportName(name) });
    }
  }

  private alarm(id: string, props: cloudwatch.AlarmProps) {
    const alarm = new cloudwatch.Alarm(this, id, {
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      ...props,
    });
    alarm.addAlarmAction(new cwActions.SnsAction(this.alarmTopic));
    alarm.addOkAction(new cwActions.SnsAction(this.alarmTopic));
    this.alarms.push(alarm);
    return alarm;
  }

  private createAlarms(config: EnvConfig, data: DataStack): void {
    const { names } = config;
    const alb = this.edge.loadBalancer;
    const fiveMinutes = Duration.minutes(5);

    // Load balancer: share of 5xx responses (ALB and targets), only once there is real traffic.
    const requests = alb.metrics.requestCount({ period: fiveMinutes });
    const elb5xx = alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, { period: fiveMinutes });
    const target5xx = alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, {
      period: fiveMinutes,
    });
    this.alarm('Alb5xxRateAlarm', {
      alarmName: `${names.prefix}-alb-5xx-rate`,
      alarmDescription: 'More than 5% of requests failed with a 5xx (load balancer or targets).',
      metric: new cloudwatch.MathExpression({
        expression: 'IF(requests >= 20, 100 * (FILL(elb5xx, 0) + FILL(target5xx, 0)) / requests, 0)',
        usingMetrics: { requests, elb5xx, target5xx },
        period: fiveMinutes,
        label: '5xx %',
      }),
      threshold: 5,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    for (const [service, targetGroup, latencySeconds] of [
      ['api', this.edge.apiTargetGroup, 2],
      ['web', this.edge.webTargetGroup, 3],
    ] as const) {
      this.alarm(`${service}LatencyAlarm`, {
        alarmName: `${names.prefix}-${service}-p95-latency`,
        alarmDescription: `p95 target response time of ${service} above ${latencySeconds}s for 15 minutes.`,
        metric: targetGroup.metrics.targetResponseTime({ statistic: 'p95', period: fiveMinutes }),
        threshold: latencySeconds,
        evaluationPeriods: 3,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      });
      this.alarm(`${service}UnhealthyHostsAlarm`, {
        alarmName: `${names.prefix}-${service}-unhealthy-hosts`,
        alarmDescription: `${service} has unhealthy targets for 5 minutes.`,
        metric: targetGroup.metrics.unhealthyHostCount({ statistic: 'Maximum', period: Duration.minutes(1) }),
        threshold: 1,
        evaluationPeriods: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      });
    }

    // Database.
    const db = data.database;
    this.alarm('DatabaseCpuAlarm', {
      alarmName: `${names.prefix}-db-cpu`,
      alarmDescription: 'Database CPU above 80% for 15 minutes.',
      metric: db.metricCPUUtilization({ period: fiveMinutes }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    this.alarm('DatabaseFreeStorageAlarm', {
      alarmName: `${names.prefix}-db-free-storage`,
      alarmDescription:
        'Less than 10% of the allocated database storage is free (autoscaling may be at its maximum).',
      metric: db.metricFreeStorageSpace({ period: fiveMinutes, statistic: 'Minimum' }),
      threshold: config.dbAllocatedStorageGiB * 1024 ** 3 * 0.1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    });
    this.alarm('DatabaseConnectionsAlarm', {
      alarmName: `${names.prefix}-db-connections`,
      alarmDescription:
        'Database connections above 80% of the estimated max_connections for this instance class.',
      metric: db.metricDatabaseConnections({ period: fiveMinutes, statistic: 'Maximum' }),
      threshold: Math.floor(estimatedMaxConnections(config.dbInstanceClass) * 0.8),
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    // Jobs queue.
    this.alarm('JobsDeadLetterAlarm', {
      alarmName: `${names.prefix}-jobs-dlq-not-empty`,
      alarmDescription:
        'Jobs failed repeatedly (or schedules could not be delivered) and are in the dead-letter queue.',
      metric: data.jobsDeadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: fiveMinutes,
        statistic: 'Maximum',
      }),
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
    this.alarm('JobsOldestMessageAlarm', {
      alarmName: `${names.prefix}-jobs-oldest-message-age`,
      alarmDescription: 'A job has waited more than 30 minutes: the worker is down, stuck or overloaded.',
      metric: data.jobsQueue.metricApproximateAgeOfOldestMessage({
        period: fiveMinutes,
        statistic: 'Maximum',
      }),
      threshold: 30 * 60,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });
  }
}

/** Nominal memory (GiB) of burstable and general-purpose instance sizes. */
const INSTANCE_SIZE_GIB: Record<string, number> = {
  micro: 1,
  small: 2,
  medium: 4,
  large: 8,
  xlarge: 16,
  '2xlarge': 32,
  '4xlarge': 64,
  '8xlarge': 128,
};

/**
 * Rough RDS PostgreSQL max_connections (LEAST(DBInstanceClassMemory / 9531392, 5000)) for an instance
 * class such as "t4g.medium"; used only for the alarm threshold.
 */
export function estimatedMaxConnections(instanceClass: string): number {
  const [family = '', size = ''] = instanceClass.split('.');
  const nominal = INSTANCE_SIZE_GIB[size];
  if (!nominal) return 100;
  // Memory-optimised families (r*, x*) have twice the memory of the same size.
  const memoryGiB = /^[rx]/.test(family) ? nominal * 2 : nominal;
  // DBInstanceClassMemory is somewhat below the nominal memory.
  return Math.min(Math.floor((memoryGiB * 1024 ** 3 * 0.9) / 9_531_392), 5000);
}
