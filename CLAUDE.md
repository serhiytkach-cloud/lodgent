# CLAUDE.md

Guidance for Claude Code sessions in this repository. Keep it current when conventions or commands change.

## What this is

Lodgent (placeholder name) makes an independent hotel's rooms, rates and attributes machine-readable and bookable by AI agents (MCP + REST), and sends those bookings straight to the hotel's PMS (Apaleo) with payment on the hotel's own Stripe connected account. The hotel pays a small booking fee instead of an OTA commission.

Read `PLAN.md` for milestone status and `docs/ARCHITECTURE.md` for the design. Decisions are recorded in `docs/adr/`.

## Commands

```bash
pnpm install
docker compose up -d          # Postgres+pgvector :5432, LocalStack :4566, Mailpit :1025/:8025
pnpm dev                      # migrate + seed, then fake Apaleo :4010, fake Stripe :4020, api :4000, web :3000, worker
pnpm test                     # all unit + integration tests (integration tests start Postgres via Testcontainers)
pnpm e2e                      # Playwright end-to-end (needs `pnpm dev` stack, or uses webServer config)
pnpm lint / pnpm lint:fix     # Biome
pnpm typecheck
pnpm build
pnpm db:generate              # drizzle-kit: generate a migration from schema changes (packages/db)
pnpm db:migrate               # apply migrations
pnpm db:seed                  # idempotent demo seed
pnpm agent-sim                # MCP client: search → offers → hold against the local API
pnpm cdk:synth                # synthesize AWS CDK stacks (never run `cdk deploy`)
```

Run a single package's tests: `pnpm --filter @lodgent/core test`, or `pnpm --filter @lodgent/core exec vitest run test/ranking.test.ts`.
Set `TEST_DATABASE_URL` to run integration tests against an existing Postgres instead of Testcontainers.

## Layout

```
apps/api            Fastify REST + MCP server (/mcp), OpenAPI at /openapi.json
apps/web            Next.js dashboard, public hotel profiles, guest checkout
apps/worker         queue consumers and scheduled jobs
packages/core       pure domain logic and ports (no I/O)
packages/application use cases that compose core + adapters; shared by api and worker
packages/db         Drizzle schema, SQL migrations, RLS, tenant-scoped repositories
packages/apaleo     Apaleo OAuth + API client, PMS adapter, fake Apaleo server
packages/payments   Stripe Connect adapter, fake Stripe server
packages/llm        LLM, embedding and visibility provider adapters
packages/taxonomy   attribute vocabulary and seeds
packages/shared     Zod schemas, brand constant, money and date helpers
infra/              AWS CDK app
scripts/            seed, agent-sim
docs/               ARCHITECTURE.md, adr/, runbooks/
```

## Conventions

- TypeScript strict everywhere, ESM, `moduleResolution: Bundler`. Internal packages export TypeScript source (`exports: ./src/index.ts`). Apps bundle them with tsup; Next.js transpiles them.
- No `any` (Biome enforces). Validate all external input (HTTP bodies, query strings, webhooks, PMS/Stripe/LLM responses, env) with Zod.
- Money: integer minor units plus an ISO currency (`Money` in `@lodgent/shared`). Never use floats for money. Convert PMS decimals with `fromMajor`.
- Dates: stay dates are property-local `YYYY-MM-DD` strings (`LocalDate`) with the property's IANA time zone. Instants are `Date`/`timestamptz`.
- `packages/core` is pure: no I/O, no env, no clock (pass `now`). All I/O goes through ports defined in core and implemented in adapter packages, so other PMSs (Mews, Cloudbeds) can be added without touching core.
- Tenancy: every tenant-owned table has `organization_id`. Use `db.tenant(orgId, fn)` for tenant work. It sets the RLS context and the repositories filter by org as well. `db.system(fn)` bypasses RLS and is only for explicitly cross-tenant paths (public catalog, webhooks, worker scans). Name such call sites clearly.
- Never accept payment card data through any API, MCP tool or form. Card entry happens only in Stripe's Payment Element.
- Never log or store guest PII in agent query logs. Guest PII lives only on holds/reservations and is purged by the retention job.
- Every Stripe and Apaleo write sends an idempotency key. Side effects go through the transactional outbox.
- Every hotel-side change writes an audit log entry (`AuditService.record`).
- Product name: only `packages/shared/src/brand.ts` and the `@lodgent/` package scope. Renaming the product means editing `BRAND` and running a repo-wide find/replace of `@lodgent/` (and the `lodgent` slug in infra and docker-compose).
- Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`), one or a few per milestone. Keep the suite green before every commit.
- Write an ADR (`docs/adr/NNNN-title.md`) for each significant decision. Keep `PLAN.md` ticked.
- Before integrating or changing an external API (Apaleo, Stripe, MCP, LLM providers), check the provider's current docs and note findings in an ADR.

## Safety rails

- Do not run `cdk deploy` or anything that creates billable AWS resources.
- Do not commit secrets. `.env` is git-ignored; `.env.example` holds only safe local defaults.
- Missing credentials: build against the fakes and list what is needed in `SETUP-NEEDED.md`.
