import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import type { EnvConfig } from './config';

export interface NetworkStackProps extends StackProps {
  config: EnvConfig;
}

export interface AppSecurityGroups {
  /** Internet-facing load balancer: 80/443 in, only to the api and web targets out. */
  alb: ec2.SecurityGroup;
  api: ec2.SecurityGroup;
  web: ec2.SecurityGroup;
  worker: ec2.SecurityGroup;
  /** One-off tasks (migrations): no inbound, database and HTTPS out. */
  oneOff: ec2.SecurityGroup;
  database: ec2.SecurityGroup;
}

export const API_PORT = 4000;
export const WEB_PORT = 3000;
export const DB_PORT = 5432;

/**
 * VPC across two AZs: public subnets (ALB, NAT), private app subnets with NAT egress (Fargate
 * tasks) and isolated data subnets (RDS). Owns every security group and rule, so the stacks that
 * use them never reference each other in a cycle.
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly securityGroups: AppSecurityGroups;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { config } = props;
    const removalPolicy = config.protectData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: config.natGateways,
      restrictDefaultSecurityGroup: true,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // Free gateway endpoint: ECR image layers and other S3 traffic skip the NAT gateway.
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }],
    });

    // Interface endpoints keep the tasks' AWS API traffic off the NAT/internet path. Each costs about
    // $7.50 per AZ per month, so they are on in prod and off in dev by default.
    if (config.interfaceEndpoints) {
      const endpoints: [string, ec2.InterfaceVpcEndpointAwsService][] = [
        ['EcrApiEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR],
        ['EcrDockerEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
        ['LogsEndpoint', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
        ['SecretsManagerEndpoint', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
        ['SqsEndpoint', ec2.InterfaceVpcEndpointAwsService.SQS],
        ['KmsEndpoint', ec2.InterfaceVpcEndpointAwsService.KMS],
      ];
      for (const [endpointId, service] of endpoints) {
        this.vpc.addInterfaceEndpoint(endpointId, {
          service,
          privateDnsEnabled: true,
          subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        });
      }
    }

    const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
      logGroupName: config.names.logGroup('vpc-flow-logs'),
      retention: config.logRetentionDays,
      removalPolicy,
    });
    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: ec2.FlowLogTrafficType[config.flowLogTraffic],
    });

    this.securityGroups = this.createSecurityGroups(config);

    new CfnOutput(this, 'AppSubnetIds', {
      description: 'Private app subnets for ECS tasks (comma-separated), e.g. for the migration run-task',
      value: this.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(','),
      exportName: config.names.exportName('AppSubnetIds'),
    });
    new CfnOutput(this, 'AppSecurityGroupId', {
      description: 'Security group for one-off app tasks (migrations): no inbound, may reach the database',
      value: this.securityGroups.oneOff.securityGroupId,
      exportName: config.names.exportName('AppSecurityGroupId'),
    });
  }

  private createSecurityGroups(config: EnvConfig): AppSecurityGroups {
    const sg = (id: string, description: string) =>
      new ec2.SecurityGroup(this, id, {
        vpc: this.vpc,
        description: `${config.names.prefix} ${description}`,
        allowAllOutbound: false,
      });
    const groups: AppSecurityGroups = {
      alb: sg('AlbSecurityGroup', 'internet-facing load balancer'),
      api: sg('ApiSecurityGroup', 'api tasks'),
      web: sg('WebSecurityGroup', 'web tasks'),
      worker: sg('WorkerSecurityGroup', 'worker tasks'),
      oneOff: sg('OneOffTaskSecurityGroup', 'one-off tasks (migrations)'),
      database: sg('DatabaseSecurityGroup', 'PostgreSQL'),
    };

    groups.alb.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'HTTP (redirects to HTTPS when TLS is on)',
    );
    groups.alb.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    groups.alb.connections.allowTo(groups.api, ec2.Port.tcp(API_PORT), 'ALB to api');
    groups.alb.connections.allowTo(groups.web, ec2.Port.tcp(WEB_PORT), 'ALB to web');
    // The web server calls the API privately (service discovery), not through the ALB and WAF.
    groups.web.connections.allowTo(groups.api, ec2.Port.tcp(API_PORT), 'web to api (internal)');

    for (const [group, name] of [
      [groups.api, 'api'],
      [groups.worker, 'worker'],
      [groups.oneOff, 'one-off tasks'],
    ] as const) {
      group.connections.allowTo(groups.database, ec2.Port.tcp(DB_PORT), `${name} to PostgreSQL`);
    }
    // Outbound HTTPS: AWS APIs, ECR, Stripe, Apaleo, LLM providers, Cognito, X-Ray. Plain HTTP only
    // for the worker's website crawler (robots.txt and sites that redirect to HTTPS).
    for (const group of [groups.api, groups.web, groups.worker, groups.oneOff]) {
      group.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS');
    }
    groups.worker.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP (website crawler)');
    return groups;
  }
}
