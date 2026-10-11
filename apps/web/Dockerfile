# syntax=docker/dockerfile:1
#
# Web image: Next.js standalone server (dashboard, public hotel profiles, guest checkout).
# Build from the repository root:
#   docker build -f apps/web/Dockerfile -t lodgent-web .
# Configuration comes from the environment at request time (apps/web/lib/env.ts), so one image
# serves every environment; nothing secret is baked in. See docs/adr/0012-containers-and-deploy-pipeline.md.

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
    pnpm dlx "turbo@$(node -p 'require("./package.json").devDependencies.turbo')" prune @lodgent/web --docker

# ---- build: install and run `next build` (output: 'standalone' in next.config.ts). Internal
# workspace packages are compiled into the server bundle (transpilePackages), and standalone
# tracing (rooted at the workspace) copies only the npm packages the server needs.
FROM base AS build
COPY --from=prune /repo/out/json/ ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY --from=prune /repo/out/full/ ./
COPY tsconfig.base.json ./
RUN mkdir -p apps/web/public \
 && pnpm exec turbo run build --filter=@lodgent/web

# ---- assets: tini (PID 1: forwards signals, reaps zombies).
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

# ---- runtime
FROM ${NODE_IMAGE} AS runtime
# Package managers are not needed at run time. Removing them keeps them out of the final file
# system, so image scans report only what the app ships.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
# HOSTNAME: Docker and ECS set it to the container's host name, and Next.js would bind only to
# that address (breaking the localhost health check). KEEP_ALIVE_TIMEOUT outlasts the load
# balancer's 60 s idle timeout so it never reuses a connection the server has just closed.
# APP_ENV=production also makes session cookies Secure.
ENV NODE_ENV=production \
    APP_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    KEEP_ALIVE_TIMEOUT=65000 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=assets /assets/tini /sbin/tini
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static apps/web/.next/static
COPY --from=build /repo/apps/web/public apps/web/public
# The only path the server writes to (fetch and image caches).
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
# The image's unprivileged "node" user, numeric so the platform can verify it is not root.
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`, { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
