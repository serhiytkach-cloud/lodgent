# 0002. Monorepo tooling

Date: 2026-10-11 · Status: accepted

## Context
The spec fixes TypeScript, Node 22, pnpm workspaces and Turborepo. We still had to choose a linter/formatter, a TypeScript version, and how internal packages are built.

## Decision
- **Biome** for lint and format: one fast tool and one config. `noExplicitAny` is an error. We give up Next.js-specific ESLint rules and accept that.
- **TypeScript 6.0** (latest 6.x), not 7.0. TypeScript 7 is the native Go port and does not yet expose the compiler API that Next.js and some tooling use. Revisit when Next.js supports it.
- **Internal packages export TypeScript source** (`"exports": "./src/index.ts"`), with no per-package build step. The API and worker are bundled with tsup (internal packages inlined, npm dependencies external). Next.js compiles them via `transpilePackages`. Vitest and tsx run source directly. This avoids build ordering and stale-`dist` bugs.
- `moduleResolution: Bundler`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`.
- **LocalStack 4.12.0** is pinned in docker-compose because later LocalStack images require an auth token.
- **Playwright 1.56.1** is pinned to match the Chromium build preinstalled in the development container. CI installs browsers for that version.

## Consequences
Packages cannot be published to npm as-is (not a goal). Any new app must bundle or transpile `@lodgent/*` packages.
