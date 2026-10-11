import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import type { EnvConfig } from './config';
import { API_PORT, type AppSecurityGroups, WEB_PORT } from './network-stack';
import { WebAcl } from './waf';

/**
 * Paths the API serves when there is no domain and both apps share the load balancer's DNS name.
 * Everything else goes to the web app. (ALB allows five values per path condition.)
 */
export const API_PATH_PATTERNS = [
  ['/v1/*', '/mcp', '/mcp/*', '/webhooks/*'],
  ['/openapi.json', '/openapi.full.json', '/readyz'],
] as const;

export interface EdgeProps {
  config: EnvConfig;
  vpc: ec2.IVpc;
  securityGroups: AppSecurityGroups;
}

/**
 * Internet-facing ALB with WAF, access logs and routing to the api and web target groups.
 *
 * - With a domain: HTTPS on 443 (ACM certificate: imported, or requested with DNS validation in the
 *   hosted zone, or pending manual validation without one), HTTP 80 redirects to HTTPS, routing by
 *   host (api.<domain> → api, app.<domain> → web, anything else 404), Route 53 aliases when a
 *   hosted zone is given.
 * - Without a domain: plain HTTP on the ALB's DNS name, API paths routed by path. Good for a first
 *   smoke test only: dashboard sign-in needs HTTPS callback URLs.
 */
export class Edge extends Construct {
  readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  readonly apiTargetGroup: elbv2.ApplicationTargetGroup;
  readonly webTargetGroup: elbv2.ApplicationTargetGroup;
  readonly webAcl: wafv2.CfnWebACL;
  readonly accessLogsBucket: s3.Bucket;
  /** Public base URLs (no trailing slash). */
  readonly webBaseUrl: string;
  readonly apiBaseUrl: string;

  constructor(scope: Construct, id: string, props: EdgeProps) {
    super(scope, id);
    const { config, vpc, securityGroups } = props;
    const { edge } = config;

    this.accessLogsBucket = new s3.Bucket(this, 'AccessLogs', {
      // ALB access logs support SSE-S3 only (not SSE-KMS).
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: Duration.days(config.logRetentionDays) }],
      removalPolicy: config.protectData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !config.protectData,
    });

    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: securityGroups.alb,
      dropInvalidHeaderFields: true,
      deletionProtection: config.protectData,
      idleTimeout: Duration.seconds(60),
    });
    this.loadBalancer.logAccessLogs(this.accessLogsBucket, 'alb');

    const targetGroup = (name: string, port: number) =>
      new elbv2.ApplicationTargetGroup(this, name, {
        vpc,
        port,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        deregistrationDelay: Duration.seconds(30),
        healthCheck: {
          path: '/healthz',
          healthyHttpCodes: '200',
          interval: Duration.seconds(15),
          timeout: Duration.seconds(5),
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 3,
        },
      });
    this.apiTargetGroup = targetGroup('ApiTargetGroup', API_PORT);
    this.webTargetGroup = targetGroup('WebTargetGroup', WEB_PORT);

    if (edge.kind === 'domain') {
      const zone = edge.hostedZone
        ? route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
            hostedZoneId: edge.hostedZone.id,
            zoneName: edge.hostedZone.name,
          })
        : undefined;
      const certificate = edge.certificateArn
        ? acm.Certificate.fromCertificateArn(this, 'Certificate', edge.certificateArn)
        : new acm.Certificate(this, 'Certificate', {
            domainName: edge.webHostname,
            subjectAlternativeNames: [edge.apiHostname],
            // Without a hosted zone the deploy waits until the validation CNAMEs (ACM console) exist.
            validation: zone ? acm.CertificateValidation.fromDns(zone) : acm.CertificateValidation.fromDns(),
          });

      const https = this.loadBalancer.addListener('Https', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        sslPolicy: elbv2.SslPolicy.TLS13_12_PQ,
        open: false,
        defaultAction: elbv2.ListenerAction.fixedResponse(404, {
          contentType: 'text/plain',
          messageBody: 'Not found',
        }),
      });
      https.addAction('Api', {
        priority: 10,
        conditions: [elbv2.ListenerCondition.hostHeaders([edge.apiHostname])],
        action: elbv2.ListenerAction.forward([this.apiTargetGroup]),
      });
      https.addAction('Web', {
        priority: 20,
        conditions: [elbv2.ListenerCondition.hostHeaders([edge.webHostname])],
        action: elbv2.ListenerAction.forward([this.webTargetGroup]),
      });
      this.loadBalancer.addListener('Http', {
        port: 80,
        open: false,
        defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
      });

      if (zone) {
        for (const [recordId, host] of [
          ['ApiAlias', edge.apiHostname],
          ['WebAlias', edge.webHostname],
        ] as const) {
          new route53.ARecord(this, recordId, {
            zone,
            recordName: `${host}.`,
            target: route53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(this.loadBalancer)),
          });
        }
      }
      this.webBaseUrl = `https://${edge.webHostname}`;
      this.apiBaseUrl = `https://${edge.apiHostname}`;
    } else {
      const http = this.loadBalancer.addListener('Http', {
        port: 80,
        open: false,
        defaultAction: elbv2.ListenerAction.forward([this.webTargetGroup]),
      });
      API_PATH_PATTERNS.forEach((patterns, index) => {
        http.addAction(`ApiPaths${index + 1}`, {
          priority: 10 + index,
          conditions: [elbv2.ListenerCondition.pathPatterns([...patterns])],
          action: elbv2.ListenerAction.forward([this.apiTargetGroup]),
        });
      });
      this.webBaseUrl = `http://${this.loadBalancer.loadBalancerDnsName}`;
      this.apiBaseUrl = this.webBaseUrl;
    }

    this.webAcl = new WebAcl(this, 'WebAcl', { config }).webAcl;
    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: this.loadBalancer.loadBalancerArn,
      webAclArn: this.webAcl.attrArn,
    });
  }
}
