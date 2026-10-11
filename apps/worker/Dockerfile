# syntax=docker/dockerfile:1
#
# Worker image: outbox dispatcher and job consumer (SQS in AWS). No inbound port.
# Build from the repository root:
#   docker build -f apps/worker/Dockerfile -t lodgent-worker .
# Configuration comes from the environment at run time (packages/application/src/config.ts);
# nothing secret is baked in. See docs/adr/0012-containers-and-deploy-pipeline.md.

# Base image, pinned by digest. Override to use a mirror (e.g. public.ecr.aws/docker/library/node).
ARG NODE_IMAGE=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
# Image for the install and build stages only; defaults to NODE_IMAGE. Behind a TLS-inspecting
# proxy, point it at NODE_IMAGE plus the proxy's CA: the runtime image stays untouched.
ARG BUILD_NODE_IMAGE=${NODE_IMAGE}

# ---- base: Node plus pnpm at the version in package.json#packageManager (via corepack).
FROM ${BUILD_NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    CI=1
WORKDIR /repo
COPY package.json ./
RUN corepack enable pnpm && corepack install

# ---- prune: just this app and the workspace packages it uses, with a pruned lockfile, so the
# install layer below is reused until one of their manifests or the lockfile changes.
FROM base AS prune
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=cache,id=pnpm-cache,target=/root/.cache/pnpm \
    pnpm dlx "turbo@$(node -p 'require("./package.json").devDependencies.turbo')" prune @lodgent/worker --docker

# ---- build: install (dev dependencies included) and bundle with tsup.
FROM base AS build
COPY --from=prune /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY --from=prune /repo/out/full/ ./
COPY tsconfig.base.json ./
RUN pnpm exec turbo run build --filter=@lodgent/worker

# ---- deploy: production node_modules for the bundle. Internal @lodgent/* packages are inlined by
# tsup (they are devDependencies), so this is only the app's own `dependencies`: its runtime
# externals (pg, pino, ...).
FROM build AS deploy
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @lodgent/worker deploy --prod --legacy --store-dir /pnpm/store /out

# ---- assets: tini (PID 1: forwards signals, reaps zombies) and the Amazon RDS CA bundle (RDS
# server certificates are not in Node's default trust store; DATABASE_SSL=true verifies them).
FROM ${NODE_IMAGE} AS assets
ARG TARGETARCH
ADD --chmod=0755 https://github.com/krallin/tini/releases/download/v0.19.0/tini-static-${TARGETARCH} /assets/tini
RUN case "${TARGETARCH}" in \
      amd64) sum=c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee ;; \
      arm64) sum=eae1d3aa50c48fb23b8cbdf4e369d0910dfc538566bfd09df89a774aa84a48b9 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && echo "${sum}  /assets/tini" > /tmp/tini.sha256 \
 && sha256sum -c /tmp/tini.sha256
ADD --chmod=0644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /assets/rds-global-bundle.pem
RUN grep -q 'BEGIN CERTIFICATE' /assets/rds-global-bundle.pem

# ---- runtime
FROM ${NODE_IMAGE} AS runtime
# Package managers are not needed at run time. Removing them keeps them out of the final file
# system, so image scans report only what the app ships.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
# APP_ENV=production makes the app refuse to start with development defaults (fail closed);
# run with -e APP_ENV=development to try the image locally.
ENV NODE_ENV=production \
    APP_ENV=production \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
WORKDIR /app
COPY --from=assets /assets/tini /sbin/tini
COPY --from=assets /assets/rds-global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
COPY --from=deploy /out/node_modules apps/worker/node_modules
COPY --from=build /repo/apps/worker/package.json apps/worker/package.json
COPY --from=build /repo/apps/worker/dist apps/worker/dist
# The image's unprivileged "node" user, numeric so the platform can verify it is not root.
USER 1000:1000
# No HEALTHCHECK: the worker serves no port. If the process exits, the orchestrator replaces it.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/worker/dist/main.js"]
