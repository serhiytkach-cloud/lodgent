# 0012. Container images and deploy pipeline

Date: 2026-10-11 · Status: accepted

## Context
M8 runs the API, the worker and the web app on ECS Fargate (the CDK app is ADR 0013). They need production images, a way to apply database migrations during a deploy, and a GitHub Actions pipeline that deploys with short-lived credentials. The images should be small, run as non-root, carry no secrets, and work for every environment.

Two existing defects came up while building the images:
- **The bundles did not start.** `node apps/api/dist/main.js` and the worker bundle crashed at startup with `Dynamic require of "events" is not supported`. tsup inlines CommonJS packages (the AWS SDK, cheerio) into ESM output, and their `require()` calls for Node built-ins have no `require` to call. Development uses `tsx`, so nothing had run the bundles before.
- **RDS TLS would have failed.** `DATABASE_SSL=true` verifies the server certificate (`rejectUnauthorized: true`), but RDS certificates chain to Amazon RDS CAs, which are not in Node's default trust store.

Checked in October 2026:
- Next.js 16.4 `output: 'standalone'` traces from the workspace root. It writes `.next/standalone/apps/web/server.js` (reads `PORT`, `HOSTNAME`, `KEEP_ALIVE_TIMEOUT`) plus a minimal `node_modules`. `.next/static` and `public/` must be copied separately.
- pnpm 10 `deploy` needs `--legacy` unless the workspace sets `inject-workspace-packages`.
- `turbo prune --docker` writes the pruned lockfile and `pnpm-workspace.yaml` (with `onlyBuiltDependencies`) into `out/json`, and `pnpm install --frozen-lockfile` accepts them. It does not copy `tsconfig.base.json`.
- tini v0.19.0 static binaries; the checksums come from the release's `.sha256sum` files.
- The pinned GitHub Actions are the latest releases, resolved to commit SHAs with `git ls-remote`, and their inputs read from each `action.yml` at that commit: `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `pnpm/action-setup` v6.1.0, `aws-actions/configure-aws-credentials` v6.3.0, `aws-actions/amazon-ecr-login` v2.1.7, `docker/setup-buildx-action` v4.4.1, `docker/build-push-action` v7.4.0.

## Decision

### Images
- **One Dockerfile per app** (`apps/{api,worker,web}/Dockerfile`), built from the repository root, with a root `.dockerignore` that keeps out `node_modules`, build output, `.env*`, `.git` and docs.
- **Stages:**
  1. `base`: Node plus pnpm through corepack, at `package.json#packageManager`.
  2. `prune`: `turbo prune <app> --docker`, with turbo at the root `devDependencies` version.
  3. `build`: `pnpm install --frozen-lockfile` from the pruned manifests (its own cached layer, with a BuildKit cache mount for the store), then `turbo run build`.
  4. `deploy` (api, worker): `pnpm deploy --prod --legacy` for the runtime `node_modules`.
  5. `assets`: tini and the RDS CA bundle.
  6. `runtime`.
- **Base image: `node:22.x-alpine`, pinned by tag and digest.**
  - `--build-arg NODE_IMAGE=...` overrides it, for example with the ECR Public mirror of the official image.
  - `--build-arg BUILD_NODE_IMAGE=...` overrides only the install and build stages. Behind a TLS-inspecting proxy, that image adds the proxy's CA, and the runtime image stays the pinned base.
  - Alpine is 65 MB smaller than `-trixie-slim` on disk (168 vs 234 MB) and has far fewer OS packages to scan. The runtime needs no native modules: Next's `sharp` ships a musl build, and pnpm picks it when installing on Alpine.
  - Rejected: distroless. It has no shell for ECS Exec, and the Node version is not pinned.
- **What is bundled and what is installed.** tsup bundles each app with every `@lodgent/*` package and the npm packages those use. The internal packages are therefore `devDependencies` of `apps/api` and `apps/worker`. An app's `dependencies` are exactly its runtime externals, and they are all that `pnpm deploy --prod` installs:
  - api: fastify and its plugins, the MCP server, pg, pino, zod;
  - worker: pg, pino, zod.

  That gives a 38 MB `node_modules` for the API, instead of the production dependencies of every internal package (the LLM SDKs, Stripe, cheerio and so on, most of which the bundle already contains).
  - **`pg` is a direct dependency, so it stays external.** OpenTelemetry instruments a library by hooking its module load, which cannot happen for code inlined into the bundle. Any library that must be instrumented or loaded from disk goes into the app's `dependencies`; tsup then leaves it external, and the image installs it.
  - A tsup banner defines `require` with `createRequire(import.meta.url)`, which fixes the startup crash.
- **Runtime hardening:**
  - Runs as uid 1000 (`node`).
  - tini as PID 1 forwards signals and reaps zombies. The apps already shut down cleanly on SIGTERM.
  - npm, npx, corepack and yarn are removed from the runtime file system.
  - No secrets in any layer. Configuration is read from the environment at run time, so one image serves every environment.
  - `APP_ENV=production` is the image default. A container missing its production configuration refuses to start instead of falling back to development defaults (`-e APP_ENV=development` to try an image locally).
  - The api and worker images set `NODE_EXTRA_CA_CERTS` to the Amazon RDS global CA bundle.
  - The api, worker and migration entrypoint work with a read-only root file system and a writable `/tmp`, as their task definitions run them.
  - api and web have a Docker `HEALTHCHECK` against `/healthz`. ECS ignores it; the task definition and target group define their own.
  - The web image sets `HOSTNAME=0.0.0.0`, because Docker and ECS set the host name and Next.js would bind only to it. It also sets `KEEP_ALIVE_TIMEOUT=65000`, above the ALB's 60 s idle timeout, to avoid 502s on reused connections. Fastify's default is already 72 s.
  - Source maps ship but are off. Set `NODE_OPTIONS=--enable-source-maps` while debugging; it is off by default because parsing the 13 MB map on the first error costs memory.
- **Sizes** (October 2026; compressed, as pushed to ECR, with the 61 MB base included): api 72 MB, worker 68 MB, web 82 MB.
- **Health route for web.** `apps/web/app/healthz/route.ts` returns `{ ok: true }` with `no-store`. It needs no auth (it is outside the proxy matcher) and does not call the API, so an API incident does not also take web out of its target group.

### Migrations
- **The API image is also the migration image.** `node apps/api/dist/migrate.js` applies the SQL files that ship at `apps/api/migrations`, which is where the bundled `@lodgent/db` looks (next to `dist/`). It exits 0 on success and 1 on any failure.
  - It reads only database settings: either `DATABASE_HOST/PORT/NAME/USER/PASSWORD` (credentials URL-encoded) or `DATABASE_URL`, plus `DATABASE_SSL`. Migrations can therefore run before the application secret is complete. It refuses to fall back to localhost in production.
- **`runMigrations` takes a session advisory lock.** drizzle reads the last applied migration before opening its transaction, so two concurrent runs (a deploy plus a manual run) failed. A test now reproduces that race. `runMigrations` also accepts `{ ssl }` with certificate verification, like `Database`.
- **Migrations run before the services change,** as a one-off Fargate task (`.github/scripts/ecs-run-migrations.sh`). It uses the migration task definition from the CDK stack, the app subnets and the app security group. ECS cannot override an image per run, so the script registers a temporary revision of that task definition with the new image, runs it, prints its log and deregisters it.
  - Consequence: every migration must keep the previous release working (expand, then contract in a later release). Rollbacks never run down-migrations.
- **First deploy.** The migration task does not exist before the platform stack does, and the API and worker cannot start on an empty schema, so the ECS deployment circuit breaker would roll the services back. When the script reports that the exports are missing (exit code 3), the pipeline therefore deploys `<prefix>-platform` first (CDK adds the stacks it depends on), migrates, and only then deploys the rest. This follows the CDK app's own order: network → data → platform → migration → services.

### Pipeline (`.github/workflows/deploy.yml`)
- **Triggers.** Manual dispatch with `environment: dev | prod`, and `v*` tags deploy to prod. GitHub environments `dev` and `prod` hold the variables. `prod` has required reviewers and accepts only `main` and `v*` tags; the job checks the ref as well.
- **Concurrency.** One deploy per environment, never cancelled half-way.
- **Credentials.** GitHub OIDC with `aws-actions/configure-aws-credentials`, using the role in `vars.AWS_DEPLOY_ROLE_ARN`. It is the `<prefix>-github-deploy` role from the CDK stack `<slug>-github-deploy`, trusted only for `repo:<owner>/<repo>:environment:<env>`. The permissions are `id-token: write` and `contents: read`. There are no long-lived AWS keys.
- **Steps:**
  1. Build and push the three images to `<slug>-<env>-{api,worker,web}`, tagged with the commit SHA. The repositories are immutable, and an image whose tag already exists is reused rather than rebuilt, which makes re-runs and rollbacks fast.
  2. Run the migrations (first deploy: deploy the platform stack first, as above).
  3. `cdk deploy` (default `<slug>-<env>-*`) with `-c env=<env> -c imageTag=<sha>`.
  4. Check the public `/healthz` and `/readyz` endpoints.
- **Inputs from CDK.** The pipeline reads CloudFormation exports, prefix = `<slug>-<env>`:
  - `<prefix>-ClusterName`, `<prefix>-MigrateTaskDefinitionArn`, `<prefix>-AppSubnetIds` (comma-separated) and `<prefix>-AppSecurityGroupId` for the migration;
  - `<prefix>-ApiUrl` and `<prefix>-WebUrl` for the smoke check.

  The migration container is the one whose image is in the `<prefix>-api` repository. Its awslogs stream prefix is used to print the log.
- **Supply chain:**
  - Third-party actions are pinned to full commit SHAs.
  - Base images are pinned by digest.
  - tini is verified by SHA-256.
  - The build uses the frozen lockfile.
  - Images carry `org.opencontainers.image.revision` and `.source` labels, and BuildKit's default provenance attestation.
- **Build caching.** Layers go to the GitHub Actions cache (`type=gha`, one scope per image). CI writes it from `main`, pull requests only read it, and deploys reuse it.
- **CI (`ci.yml`, job `images`).** Builds all three images on every push and PR (no push) and runs `.github/scripts/smoke-test-images.sh`. The script boots them against a throwaway Postgres in production mode with placeholder secrets, with a read-only root file system where ECS uses one. It checks:
  - the user is not root;
  - migrations, with both configuration styles, the migration count, idempotency and a failure exit code;
  - `/healthz`, `/readyz` and container health;
  - worker start-up;
  - a rendered page with its static assets;
  - clean SIGTERM shutdown.

  With a warm cache the job takes a few minutes and runs in parallel with the other jobs, so it does not lengthen CI. It would have caught the startup crash. RDS TLS can only be checked in AWS; the post-deploy `/readyz` check covers it.

## Consequences
- Images are built per environment rather than promoted from dev to prod, because the ECR repositories are per environment. The pinned lockfile, base digest and build cache make them equivalent. Promoting by digest (copying from `dev` to `prod`) is a possible follow-up.
- Images are `linux/amd64`, matching the CDK default `cpuArchitecture: x86_64`. Switching an environment to Graviton (`arm64`) also needs arm64 builds (`platforms` in `deploy.yml`, on an arm runner or with QEMU).
- The web task needs a writable `/app/apps/web/.next/cache` if it ever runs with a read-only root file system.
- The pinned base digest and action SHAs need regular bumps (Dependabot or Renovate, not set up yet). The RDS CA bundle and tini are fetched at build time from AWS and GitHub.
- The pipeline depends on the CDK stack names only for the first deploy (`CDK_MIGRATION_STACKS`, default `<prefix>-platform`); otherwise it relies on the exports above.
- A first deploy needs the ECR repositories, the deploy role, the database and the app secret to exist before the pipeline runs (docs/runbooks/deploy.md).
