# Runbook: deploying to AWS

How the API, worker and web app get to AWS: setting up an environment for the first time, regular deploys, rollback, and running migrations by hand. Design: [ADR 0012](../adr/0012-containers-and-deploy-pipeline.md) (images and pipeline) and ADR 0013 (CDK stacks). Stack configuration and operations: [aws-infrastructure.md](aws-infrastructure.md).

```
GitHub Actions "Deploy" (manual: dev | prod, or a v* tag → prod after approval)
  1. build + push   <prefix>-api / -worker / -web : <commit sha>             (ECR; reused if the tag exists)
  2. migrate        one-off Fargate task: api image, `node apps/api/dist/migrate.js`
                    (first deploy: `cdk deploy <prefix>-platform` first, which creates the migration task)
  3. cdk deploy     <prefix>-*  -c env=<env> -c imageTag=<commit sha>
  4. smoke check    <ApiUrl>/healthz, <ApiUrl>/readyz, <WebUrl>/healthz
```

Names: `<slug>` = `BRAND.slug` (`lodgent`), `<env>` = `dev` or `prod`, `<prefix>` = `<slug>-<env>`. The stacks are `<prefix>-network`, `<prefix>-data`, `<prefix>-platform` and `<prefix>-services`, plus `<slug>-github-deploy` once per account.

## First-time setup (per environment)

You need administrator credentials for the AWS account, Node 22, pnpm, the AWS CLI, and a domain whose DNS you control. Use a separate AWS account per environment if you can. dev and prod can share one account, because every name carries the environment.

Every `cdk` command below runs as `pnpm --filter @lodgent/infra exec cdk …` from the repository root, after `pnpm install`.

### 1. Configure and bootstrap CDK
1. Set the environment's values in `infra/cdk.json` under `environments.<env>`, at least `domainName`, plus `hostedZoneId` if the zone is in Route 53 (see [aws-infrastructure.md](aws-infrastructure.md#configuration-cdk-context)). Commit that.
2. Bootstrap the account and region once:
   ```bash
   cdk bootstrap aws://<ACCOUNT_ID>/<REGION>
   ```

### 2. Deploy role for GitHub Actions (OIDC)
```bash
cdk deploy <slug>-github-deploy -c githubRepo=<owner>/<repo>
```
This creates the account's GitHub OIDC provider and one role per environment, `<prefix>-github-deploy`. Add `-c githubOidcProviderArn=…` if the account already has the provider, and `-c githubDeployEnvs=prod` (or `dev`) when the environments live in separate accounts.

The role's ARN is the stack output and export `<prefix>-GithubDeployRoleArn`. Its trust policy accepts only this repository's workflow jobs running in the GitHub environment of the same name:
- `token.actions.githubusercontent.com:aud` = `sts.amazonaws.com`
- `token.actions.githubusercontent.com:sub` = `repo:<owner>/<repo>:environment:<env>`

There are no long-lived AWS keys anywhere. What the role may do:

| Purpose | Permissions |
| --- | --- |
| `cdk deploy` | assume the CDK bootstrap roles (`cdk-<qualifier>-*`); CloudFormation then acts with the bootstrap execution policy |
| Pipeline inputs | `cloudformation:ListExports`, `cloudformation:DescribeStacks` on `<prefix>-*` |
| Images | `ecr:GetAuthorizationToken`; push and describe on `<prefix>-api`, `<prefix>-worker`, `<prefix>-web` |
| Migration task | `ecs:DescribeTaskDefinition`, `ecs:RegisterTaskDefinition`, `ecs:DeregisterTaskDefinition`; `ecs:RunTask` on the `<prefix>-migrate` family in the `<prefix>` cluster; `ecs:DescribeTasks`, `ecs:StopTask`; `iam:PassRole` on the migration task's two roles only |
| Migration log | `logs:GetLogEvents` on `/<slug>/<env>/migrate` |

### 3. Network and data
```bash
cdk deploy <prefix>-network <prefix>-data -c env=<env>
```
This creates the VPC, the database (10 to 20 minutes), the ECR repositories the pipeline pushes to, Cognito, and the app secret `<slug>/<env>/app`.

### 4. DNS and TLS certificates
- **Hosted zone in Route 53 (`hostedZoneId` set):** CDK validates the ACM certificate and creates the alias records for `api.<domain>` and `app.<domain>`. Nothing to do.
- **DNS hosted elsewhere:** CloudFormation waits until the certificate is validated, so deploy the platform stack from your workstation and add the validation records while it waits:
  ```bash
  cdk deploy <prefix>-platform -c env=<env>
  ```
  1. Open ACM in the console, find the pending certificate and add its `CNAME` records at your DNS provider.
  2. When the stack is done, point `api.<domain>` and `app.<domain>` (`CNAME`) at the `<prefix>-LoadBalancerDnsName` export.

  Alternatively, set `certificateArn` to an already-issued certificate that covers both host names.
- **Email (SES):** add the DKIM records (`EmailDkimRecord1..3` outputs of the data stack) and request SES production access. Details: [aws-infrastructure.md](aws-infrastructure.md).

### 5. Fill in the app secret
CDK creates `<slug>/<env>/app` with every key the tasks read, as empty strings, except `SIGNING_SECRET`, which it generates. ECS refuses to start a task whose secret lacks a referenced key, so **keep every key**. Leave optional ones empty.

| Key | Value |
| --- | --- |
| `INTERNAL_API_TOKEN` | random: `openssl rand -hex 32` |
| `AUTH_DEV_SECRET` | random, at least 32 characters: `openssl rand -hex 32` |
| `SIGNING_SECRET` | generated by CDK; keep it |
| `APALEO_CLIENT_ID`, `APALEO_CLIENT_SECRET` | the Apaleo app registration ([SETUP-NEEDED.md](../../SETUP-NEEDED.md)) |
| `APALEO_WEBHOOK_TOKEN` | random: `openssl rand -hex 32` |
| `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY` | Stripe API keys (test-mode keys for dev) |
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` | signing secrets of the two Stripe webhook endpoints (step 8; fill in after the first deploy) |
| `COGNITO_CLIENT_SECRET` | `aws cognito-idp describe-user-pool-client --user-pool-id <UserPoolId> --client-id <UserPoolClientId> --query UserPoolClient.ClientSecret --output text` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `VOYAGE_API_KEY` | provider keys; empty turns the provider off |

Edit the JSON in a file, not on the command line, so it stays out of your shell history:
```bash
aws secretsmanager get-secret-value --secret-id <slug>/<env>/app --query SecretString --output text > app.json
# edit app.json
aws secretsmanager put-secret-value --secret-id <slug>/<env>/app --secret-string file://app.json
shred -u app.json   # rm -P on macOS
```
Tasks read secrets when they start. After a change, run the pipeline again or force a new deployment of the three services (`aws ecs update-service --cluster <prefix> --service <name> --force-new-deployment`; names in the `<prefix>-ApiServiceName`, `-WorkerServiceName` and `-WebServiceName` exports). Migrations need only the database secret, so they also run while this one is still incomplete.

### 6. GitHub environments and variables
In the repository, open **Settings → Environments**.

1. **Create the environments `dev` and `prod`.** The names must match the role's trust policy.
2. **Protect `prod`:**
   - *Required reviewers:* at least one person, with *Prevent self-review* on. Every prod deploy job then waits for an approval before it starts, and the AWS role cannot be assumed until then.
   - *Deployment branches and tags:* "Selected branches and tags", with `main` and the tag pattern `v*`. The workflow also refuses other refs for prod.
3. **Add environment variables** to each environment. These are *variables*, not secrets; nothing here is secret.

   | Variable | Example | Required |
   | --- | --- | --- |
   | `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::123456789012:role/<prefix>-github-deploy` (export `<prefix>-GithubDeployRoleArn`) | yes |
   | `AWS_REGION` | `eu-central-1`: the region the environment's stacks are in (CDK `region`, default `eu-central-1`) | yes |
   | `CDK_STACKS` | stacks to deploy, space-separated names or patterns; default `<prefix>-*` | no |
   | `CDK_MIGRATION_STACKS` | stacks that define the migration task, deployed before migrating on a first deploy; default `<prefix>-platform` | no |
   | `NODE_IMAGE` | base image override, e.g. `public.ecr.aws/docker/library/node:22.23.3-alpine3.24@sha256:…` (avoids Docker Hub rate limits) | no |
   | `API_BASE_URL`, `WEB_BASE_URL` | URLs for the smoke check; default: the `<prefix>-ApiUrl` and `<prefix>-WebUrl` exports | no |

4. **Protect release tags:** **Settings → Rules → Rulesets**, a tag ruleset for `v*` that allows only maintainers to create, update and delete them, because a `v*` tag starts a prod deploy (which still waits for approval).

### 7. First pipeline run
**Actions → Deploy → Run workflow**, branch `main`, environment `dev`. On a first deploy, the migration step finds no migration task yet. It then:
1. deploys `<prefix>-platform`: the ECS cluster, load balancer, WAF, migration task definition and schedules;
2. migrates the empty database;
3. lets the next step create `<prefix>-services`.

The services can only start on a migrated schema; the API and worker refuse to start without it.

### 8. External callbacks
Once the URLs answer, register them ([SETUP-NEEDED.md](../../SETUP-NEEDED.md) has the details):
- **Stripe:** two webhook endpoints at `<API_BASE_URL>/webhooks/stripe` (account events and Connect events). Put their signing secrets into the app secret, then redeploy.
- **Apaleo:** the app's redirect URI `<API_BASE_URL>/v1/integrations/apaleo/callback`.
- **Cognito:** CDK already registers `<WEB_BASE_URL>/auth/callback` and `<WEB_BASE_URL>/login`.

Repeat steps 3 to 8 for `prod`.

## Regular deploys
- **dev:** **Actions → Deploy → Run workflow** with environment `dev`, from `main` or a branch.
- **prod:** tag a commit on `main`, then a reviewer approves the waiting job:
  ```bash
  git tag -a v1.4.0 -m "v1.4.0" && git push origin v1.4.0
  ```
  Dispatching the workflow from `main` with environment `prod` works too.

Deploy commits that passed CI: the deploy workflow does not run the tests again. One deploy per environment runs at a time; another one waits for it, and a running deploy is never cancelled.

**If a step fails:**
- **Build or push:** nothing changed in AWS.
- **Migration:** the services were not touched. The job prints the migration log; the full log is in `/<slug>/<env>/migrate`. Fix forward (a new migration in a new commit) and deploy again.
- **`cdk deploy`:** CloudFormation rolls the stack back, and ECS rolls back a service deployment that does not become healthy (deployment circuit breaker). The schema stays migrated, which is safe because migrations are backward compatible (below).
- **Smoke check:** the new version is live but not answering. Check the services and their logs in ECS and CloudWatch, then roll back if needed.

**Migrations must be backward compatible.** They run before the new code is deployed, and neither a failed deploy nor a rollback undoes them. Use expand and contract:
1. Add the new column, table or index (nullable or with a default) and deploy code that copes with both shapes.
2. Remove the old one in a later release, once no running version uses it.

Never rename or drop something that the running release still uses.

## Rollback
Images are tagged with the commit SHA, and a SHA that already has images is never rebuilt, so a rollback is a deploy of an earlier commit:
1. **Re-run the last good deploy:** open its run under **Actions → Deploy** and choose **Re-run all jobs**. It deploys that commit's images and that commit's infrastructure code. Its migration step applies nothing, because the newer migrations are already in place. A prod re-run needs an approval again.
2. **Or dispatch the workflow from an earlier tag:** *Use workflow from* → *Tags* → `v1.3.2`, environment `prod`.
3. **Emergency, from a workstation**, with the deploy role or administrator credentials, without building anything:
   ```bash
   git checkout <good sha>
   pnpm install --frozen-lockfile
   pnpm --filter @lodgent/infra exec cdk deploy '<prefix>-*' -c env=<env> -c imageTag=<good sha> --require-approval never
   ```

Database changes are not rolled back. If a migration itself is wrong, write a new migration that repairs it. Restoring an RDS snapshot or a point-in-time copy loses every write made since, so do that only deliberately during an incident.

## Running migrations manually
- **In AWS, as the pipeline does it:**
  ```bash
  .github/scripts/ecs-run-migrations.sh <prefix> <account>.dkr.ecr.<region>.amazonaws.com/<prefix>-api:<sha>
  ```
  It needs the AWS CLI, `jq`, and credentials with the deploy role's permissions. It reads the cluster, migration task definition, subnets and security group from the stack exports, runs `node apps/api/dist/migrate.js` as a Fargate task with that image, prints the log, and exits non-zero if the migrations fail (3 if the stacks do not exist yet). Use the SHA that is deployed or about to be.
- **Against any reachable database, with Docker:**
  ```bash
  docker run --rm -e DATABASE_URL='postgres://user:pass@host:5432/db' -e DATABASE_SSL=true \
    <api image> node apps/api/dist/migrate.js
  ```
  `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER` and `DATABASE_PASSWORD` work instead of `DATABASE_URL`, as in ECS.
- **Local development:** `pnpm db:migrate`.

Migrations hold a Postgres advisory lock while they run, so concurrent runs wait for each other instead of colliding.

## Building and testing the images locally
```bash
docker build -f apps/api/Dockerfile -t lodgent-api:dev .
docker build -f apps/worker/Dockerfile -t lodgent-worker:dev .
docker build -f apps/web/Dockerfile -t lodgent-web:dev .
API_IMAGE=lodgent-api:dev WORKER_IMAGE=lodgent-worker:dev WEB_IMAGE=lodgent-web:dev \
  .github/scripts/smoke-test-images.sh
```
The smoke test (CI runs it too) starts the images against a throwaway Postgres, in production mode with placeholder secrets, and removes everything afterwards.

- **Behind a TLS-inspecting proxy:** build a base image that trusts the proxy's CA and pass it with `--build-arg BUILD_NODE_IMAGE=<that image>`. Only the install and build stages use it; the runtime image stays the pinned base.
- **Trying an image by hand:** pass `-e APP_ENV=development`. The images default to production and refuse to start with development defaults:
  ```bash
  docker run --rm -p 4000:4000 -e APP_ENV=development \
    -e DATABASE_URL=postgres://lodgent:lodgent@host.docker.internal:5432/lodgent lodgent-api:dev
  ```

## Troubleshooting
| Symptom | Likely cause |
| --- | --- |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | The job's GitHub environment does not match the role (`repo:<owner>/<repo>:environment:<env>`), or `AWS_DEPLOY_ROLE_ARN` holds the other environment's role. |
| `ECR repository … does not exist yet` | The data stack is not deployed (first-time setup, step 3). |
| `CloudFormation export … not found` | A stack does not publish an export the pipeline reads (ADR 0012 lists them). |
| Migration task `CannotPullContainerError` | The app subnets cannot reach ECR (NAT gateway or VPC endpoints), or the execution role lacks ECR permissions. |
| Task `ResourceInitializationError … secrets` | A key is missing from `<slug>/<env>/app`, or the execution role cannot read or decrypt the secret. |
| `self-signed certificate in certificate chain` when connecting to the database | `NODE_EXTRA_CA_CERTS` was overridden in the task definition; the api and worker images set it to the Amazon RDS CA bundle. |
| API or worker exits with `Production configuration is incomplete` | Values in the app secret are missing, or still development defaults. |
| The services stack rolls back on the first deploy | The schema was not migrated: check the migration step's log. |
| Smoke check fails right after a first deploy | DNS or certificate validation is still propagating. Re-run the workflow later. |
