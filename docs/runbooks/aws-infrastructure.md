# AWS infrastructure (CDK) runbook

How the CDK app in `infra/` is configured, set up the first time and operated. Design and costs: ADR 0013. The deploy pipeline (image builds, migrations, `cdk deploy`) is described in `docs/runbooks/deploy.md` (ADR 0012).

Never run `cdk deploy` from a development machine against prod. Deploys go through the pipeline, except for the one-time administrator steps below.

## Stacks

Per environment (`dev`, `prod`), in deploy order:

| Stack | What it holds |
| --- | --- |
| `lodgent-<env>-network` | VPC, endpoints, flow logs, all security groups |
| `lodgent-<env>-data` | KMS keys, PostgreSQL, app secret, jobs queue + DLQ, ECR repositories, Cognito, SES |
| `lodgent-<env>-platform` | ECS cluster, ALB + WAF (+ certificate, DNS), migration task definition, schedules, alarm topic and alarms |
| `lodgent-<env>-services` | api, worker and web services, autoscaling, service alarms, dashboard |

Plus `lodgent-github-deploy`: the GitHub OIDC provider and deploy roles, deployed once per account by an administrator.

`pnpm cdk:synth` synthesizes everything offline. `cdk deploy 'lodgent-dev-*'` deploys an environment; CDK orders the stacks by their dependencies.

## Configuration (CDK context)

Set per-environment values in `infra/cdk.json` under `"environments"` (committed, reviewed). Override them for one run with `-c <env>.<key>=<value>`:

```json
"environments": {
  "prod": {
    "domainName": "lodgent.example",
    "hostedZoneId": "Z0123456789ABCDEFGHIJ",
    "alarmEmail": "ops@lodgent.example",
    "appEnvironment": { "EMBEDDINGS_PROVIDER": "openai" },
    "api": { "maxCount": 8 }
  }
}
```

Global keys: `imageTag` (git SHA, default `latest`), `env` (synthesize one environment only), `region` (default `eu-central-1`), `githubRepo` (default `serhiytkach-cloud/lodgent`), `githubDeployEnvs` (default `dev,prod`), `githubOidcProviderArn`, `cdkQualifier` (default `hnb659fds`).

Per-environment keys (defaults in `infra/lib/config.ts`, `ENV_DEFAULTS`):

| Key | dev | prod | Notes |
| --- | --- | --- | --- |
| `region` | global | global | Per-environment region override |
| `domainName` | – | – | Enables HTTPS and host routing: `api.<domain>`, `app.<domain>` |
| `hostedZoneId` / `hostedZoneName` | – | – | Route 53 public zone (name defaults to `domainName`; may be a parent zone). Automates certificate validation, aliases and SES DNS records |
| `certificateArn` | – | – | Use an existing ACM certificate (covering both hostnames) |
| `apiHostname` / `webHostname` | `api.` / `app.` + domain | same | Override the hostnames |
| `emailFrom` | `Lodgent Bookings <bookings@<domain>>` | same | Must be inside the verified SES domain |
| `alarmEmail` | – | – | SNS email subscription for alarms |
| `cognitoDomainPrefix` | `lodgent-dev-<account>` | `lodgent-prod-<account>` | Hosted UI prefix, unique per region |
| `cognitoThreatProtection` | `off` | `off` | `audit`/`enforced` switches to the Plus plan (billed per MAU) |
| `natGateways` | 1 | 2 | |
| `interfaceEndpoints` | false | true | ECR, Logs, Secrets Manager, SQS, KMS (~$105/month in prod) |
| `flowLogTraffic` | REJECT | ALL | |
| `dbInstanceClass` | t4g.micro | t4g.medium | Without the `db.` prefix |
| `dbAllocatedStorageGiB` / `dbMaxAllocatedStorageGiB` | 20 / 100 | 50 / 500 | gp3 with storage autoscaling |
| `dbMultiAz` | false | true | |
| `dbBackupRetentionDays` | 3 | 30 | |
| `protectData` | false | true | Deletion protection, RETAIN policies, stack termination protection |
| `logRetentionDays` | 14 | 90 | Also the ALB access-log expiry |
| `wafRateLimitPer5Min` | 2000 | 2000 | Requests per IP per 5 minutes (webhooks exempt) |
| `fargateSpot` | true | false | |
| `cpuArchitecture` | x86_64 | x86_64 | `arm64` only with arm64 images |
| `enableExecuteCommand` | false | false | ECS Exec for debugging |
| `appEnvironment` | {} | {} | Extra plain env for api and worker. Secrets and `DATABASE_*` are refused |
| `api` / `web` / `worker` | 512/1024, 1–2 | api 1024/2048, 2–6; web 512/1024, 2–4; worker 1024/2048, 1–4 | `{ cpu, memoryMiB, minCount, maxCount }`; `minCount: 0` pins the service at 0 tasks |

Without `domainName` the ALB serves plain HTTP on its DNS name, with API paths routed by path. That is fine for a smoke test, but dashboard sign-in does not work: Cognito only allows HTTP callbacks for localhost.

## First-time setup (per AWS account, administrator)

1. **Bootstrap CDK** in the account and region:
   `pnpm --filter @lodgent/infra exec cdk bootstrap aws://<account>/<region>`.
   Consider `--cloudformation-execution-policies` with a narrower policy than AdministratorAccess.
2. **GitHub deploy roles.** In a single-account setup:
   `pnpm --filter @lodgent/infra exec cdk deploy lodgent-github-deploy`.
   - Separate dev and prod accounts: add `-c githubDeployEnvs=dev` or `=prod` per account.
   - An existing GitHub OIDC provider: add `-c githubOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com`.
   - Put the `lodgent-<env>-GithubDeployRoleArn` export into the GitHub environment `<env>` (see deploy.md), and require reviewers on `prod`.
3. **Network and data stacks:** `cdk deploy lodgent-<env>-network lodgent-<env>-data`. This creates the ECR repositories the pipeline pushes to, and the database (10 to 20 minutes).
4. **Fill the app secret** `lodgent/<env>/app`. It is created with every key as an empty string, except a generated `SIGNING_SECRET`. ECS fails to start a task whose secret lacks a key, so keep all keys.

   ```bash
   aws secretsmanager get-secret-value --secret-id lodgent/<env>/app --query SecretString --output text > app.json
   # Edit app.json. Required in production:
   #   INTERNAL_API_TOKEN, AUTH_DEV_SECRET     random (openssl rand -hex 32)
   #   APALEO_CLIENT_ID/SECRET, APALEO_WEBHOOK_TOKEN (random)
   #   STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET (+ STRIPE_CONNECT_WEBHOOK_SECRET)
   #   COGNITO_CLIENT_SECRET (below)
   # Optional: ANTHROPIC/OPENAI/GEMINI/PERPLEXITY/VOYAGE API keys (empty = provider off)
   aws cognito-idp describe-user-pool-client --user-pool-id <UserPoolId> --client-id <UserPoolClientId> \
     --query UserPoolClient.ClientSecret --output text
   aws secretsmanager put-secret-value --secret-id lodgent/<env>/app --secret-string file://app.json
   shred -u app.json
   ```

   Running tasks keep the values they started with. After a change, run `aws ecs update-service --force-new-deployment` for the api, worker and web.
5. **DNS and email**:
   - Without a hosted zone, add the ACM validation CNAMEs (ACM console; the platform deploy waits for them), and point `api.`/`app.<domain>` at `lodgent-<env>-LoadBalancerDnsName`.
   - Add the SES DKIM CNAMEs (`EmailDkimRecord1..3` outputs) and the MAIL FROM records for `mail.<domain>`: MX `10 feedback-smtp.<region>.amazonses.com` and TXT `v=spf1 include:amazonses.com ~all`.
   - Publish a DMARC record, and request SES production access.
6. **Run the pipeline** (deploy.md). It pushes images, migrates and deploys `platform` and `services`.
7. **Confirm** the SNS alarm subscription email.
8. **Register webhooks** at `https://api.<domain>`:
   - Stripe: `/webhooks/stripe`, platform and Connect endpoints, with their signing secrets in the app secret.
   - Apaleo: the app subscribes itself, using `APALEO_WEBHOOK_TOKEN`.

## Outputs the pipeline uses

Exports, read with `aws cloudformation list-exports`, are named `lodgent-<env>-<Name>`:

| Name | Stack | Value |
| --- | --- | --- |
| `AppSubnetIds` | network | Private app subnet IDs, comma-separated |
| `AppSecurityGroupId` | network | Security group for one-off tasks (may reach the database) |
| `ApiRepositoryUri`, `WorkerRepositoryUri`, `WebRepositoryUri` | data | ECR repositories (tag = git SHA) |
| `AppSecretArn`, `DatabaseSecretArn`, `DatabaseEndpoint`, `JobsQueueUrl`, `UserPoolId`, `UserPoolClientId`, `CognitoDomain`, `AppKmsKeyArn` | data | For operators |
| `ClusterName` | platform | ECS cluster |
| `MigrateTaskDefinitionArn`, `MigrateTaskFamily`, `MigrateLogGroupName` | platform | Migration task (container `migrate`, command `node apps/api/dist/migrate.js`) |
| `LoadBalancerDnsName`, `WebUrl`, `ApiUrl` | platform | Public endpoints (`ApiUrl` serves `/healthz`, `/readyz`, `/mcp`) |
| `AlarmTopicArn` | platform | SNS topic |
| `ApiServiceName`, `WorkerServiceName`, `WebServiceName` | services | For `aws ecs wait services-stable` |
| `GithubDeployRoleArn` | github-deploy | Role for the GitHub environment |

Running the migration by hand:

```bash
aws ecs run-task --cluster lodgent-<env> --launch-type FARGATE \
  --task-definition <MigrateTaskDefinitionArn> \
  --network-configuration 'awsvpcConfiguration={subnets=[<AppSubnetIds>],securityGroups=[<AppSecurityGroupId>],assignPublicIp=DISABLED}'
```

## Operations

- **Alarms and dashboard:** the CloudWatch dashboard `lodgent-<env>`; alarms named `lodgent-<env>-*` notify the SNS topic.
- **Dead-letter queue** (`lodgent-<env>-jobs-dlq`): read the worker logs for the job type, fix the cause, then use "Start DLQ redrive" in the SQS console (back to `lodgent-<env>-jobs`). Undeliverable scheduler runs land there too.
- **Scaling:** change `<env>.api.maxCount` etc. in `cdk.json` and deploy. Autoscaling owns the running count, and deploys do not reset it.
- **Shell in a task:** deploy with `-c <env>.enableExecuteCommand=true`, then `aws ecs execute-command --cluster lodgent-<env> --task <id> --container api --interactive --command sh`.
- **Database access:** there is no public endpoint. Use ECS Exec into an api task, or a temporary bastion in the app subnets with the one-off security group.
- **Logs:** `/lodgent/<env>/{api,worker,web,migrate}` (the collector sidecar logs under the `otel-collector/` stream prefix); VPC flow logs `/lodgent/<env>/vpc-flow-logs`; WAF `aws-waf-logs-lodgent-<env>` (blocked and counted requests only); ALB access logs in the platform stack's bucket under `alb/`.
- **WAF false positive:**
  1. Find the rule in the WAF logs (`terminatingRuleId`, labels).
  2. Switch that single managed rule to count via `ruleActionOverrides` in `infra/lib/waf.ts`.
  3. If needed, re-enforce it with a label rule that excludes only the affected path (as done for body size).
- **Tearing down dev:** `cdk destroy 'lodgent-dev-*'`. The database leaves a final snapshot, and KMS keys enter their 30-day deletion window. Prod stacks have termination protection and retain their data.
