import { ArnFormat, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import type { EnvConfig } from './config';

/** Paths whose request bodies may exceed the 8 KB the WAF inspects on an ALB. */
export const LARGE_BODY_PATHS = {
  /** Stripe and Apaleo webhooks: payloads are signature- or token-verified by the API. */
  prefixes: ['/webhooks/', '/app/'],
  /** MCP Streamable HTTP endpoint: JSON-RPC requests, validated by the MCP server. */
  exact: ['/mcp'],
} as const;

const CRS_LABEL = 'awswaf:managed:aws:core-rule-set';

export interface WebAclProps {
  config: EnvConfig;
}

/**
 * Regional web ACL for the public load balancer.
 *
 * Rules, in order: Amazon IP reputation list, a per-IP rate limit (webhooks exempt), the core rule
 * set, two narrow re-implementations of CRS rules that are switched to "count", known bad inputs
 * and SQL injection.
 *
 * Exceptions, and why they are narrow:
 *  - SizeRestrictions_BODY (bodies over 8 KB) is counted, then blocked again by our own rule unless
 *    the path is a webhook, the MCP endpoint or the signed-in dashboard (`/app/`: Next.js server
 *    actions post whole forms). Stripe events and MCP tool calls are routinely larger than 8 KB.
 *    Everything else (agent REST API, checkout, sign-in) keeps the 8 KB limit.
 *  - NoUserAgent_HEADER is counted, then blocked again except on `/webhooks/` (provider callbacks
 *    may not send a User-Agent; they are authenticated by signature or token).
 * The other CRS, SQLi and bad-input rules still inspect those paths. The anonymous-IP and
 * hosting-provider lists are deliberately not used: AI agents call from cloud IP ranges.
 */
export class WebAcl extends Construct {
  readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: WebAclProps) {
    super(scope, id);
    const { config } = props;
    const metric = (name: string) => ({
      cloudWatchMetricsEnabled: true,
      sampledRequestsEnabled: true,
      metricName: `${config.names.pascal}${name}`,
    });
    const managed = (
      priority: number,
      name: string,
      ruleActionOverrides?: wafv2.CfnWebACL.RuleActionOverrideProperty[],
    ): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name, ruleActionOverrides } },
      visibilityConfig: metric(name),
    });
    const pathStartsWith = (prefix: string): wafv2.CfnWebACL.StatementProperty => ({
      byteMatchStatement: {
        fieldToMatch: { uriPath: {} },
        positionalConstraint: 'STARTS_WITH',
        searchString: prefix,
        textTransformations: [{ priority: 0, type: 'NONE' }],
      },
    });
    const pathIs = (path: string): wafv2.CfnWebACL.StatementProperty => ({
      byteMatchStatement: {
        fieldToMatch: { uriPath: {} },
        positionalConstraint: 'EXACTLY',
        searchString: path,
        textTransformations: [{ priority: 0, type: 'NONE' }],
      },
    });
    const anyOf = (statements: wafv2.CfnWebACL.StatementProperty[]): wafv2.CfnWebACL.StatementProperty =>
      statements.length === 1 ? statements[0]! : { orStatement: { statements } };
    const labelled = (label: string): wafv2.CfnWebACL.StatementProperty => ({
      labelMatchStatement: { scope: 'LABEL', key: `${CRS_LABEL}:${label}` },
    });
    const blockUnless = (
      priority: number,
      name: string,
      label: string,
      allowed: wafv2.CfnWebACL.StatementProperty[],
    ): wafv2.CfnWebACL.RuleProperty => ({
      name,
      priority,
      action: { block: {} },
      statement: {
        andStatement: { statements: [labelled(label), { notStatement: { statement: anyOf(allowed) } }] },
      },
      visibilityConfig: metric(name),
    });

    const largeBodyPaths = [
      ...LARGE_BODY_PATHS.prefixes.map(pathStartsWith),
      ...LARGE_BODY_PATHS.exact.map(pathIs),
    ];

    this.webAcl = new wafv2.CfnWebACL(this, 'Resource', {
      name: `${config.names.prefix}-alb`,
      description: `${config.names.prefix} public load balancer`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: metric('WebAcl'),
      rules: [
        managed(0, 'AWSManagedRulesAmazonIpReputationList'),
        {
          name: 'RateLimitPerIp',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: config.wafRateLimitPer5Min,
              evaluationWindowSec: 300,
              aggregateKeyType: 'IP',
              // Webhook senders (Stripe, Apaleo) share few IPs and retry in bursts.
              scopeDownStatement: { notStatement: { statement: pathStartsWith('/webhooks/') } },
            },
          },
          visibilityConfig: metric('RateLimitPerIp'),
        },
        managed(2, 'AWSManagedRulesCommonRuleSet', [
          { name: 'SizeRestrictions_BODY', actionToUse: { count: {} } },
          { name: 'NoUserAgent_HEADER', actionToUse: { count: {} } },
        ]),
        blockUnless(3, 'BodySizeLimitExceptLargeBodyPaths', 'SizeRestrictions_Body', largeBodyPaths),
        blockUnless(4, 'NoUserAgentExceptWebhooks', 'NoUserAgent_Header', [pathStartsWith('/webhooks/')]),
        managed(5, 'AWSManagedRulesKnownBadInputsRuleSet'),
        managed(6, 'AWSManagedRulesSQLiRuleSet'),
      ],
    });

    // Only blocked and counted requests are logged (cost), with credentials redacted.
    const logGroupName = `aws-waf-logs-${config.names.prefix}`;
    const logGroup = new logs.LogGroup(this, 'Logs', {
      logGroupName,
      retention: config.logRetentionDays,
      removalPolicy: config.protectData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const logging = new wafv2.CfnLoggingConfiguration(this, 'Logging', {
      resourceArn: this.webAcl.attrArn,
      logDestinationConfigs: [
        Stack.of(this).formatArn({
          service: 'logs',
          resource: 'log-group',
          resourceName: logGroupName,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
      redactedFields: [
        { singleHeader: { Name: 'authorization' } },
        { singleHeader: { Name: 'cookie' } },
        { singleHeader: { Name: 'x-api-key' } },
      ],
      loggingFilter: {
        DefaultBehavior: 'DROP',
        Filters: [
          {
            Behavior: 'KEEP',
            Requirement: 'MEETS_ANY',
            Conditions: [{ ActionCondition: { Action: 'BLOCK' } }, { ActionCondition: { Action: 'COUNT' } }],
          },
        ],
      },
    });
    logging.node.addDependency(logGroup);
  }
}
