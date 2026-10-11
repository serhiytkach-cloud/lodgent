# Lodgent MVP: plan and progress

Agent-ready direct booking for independent hotels. This file tracks the milestone checklist; tick items as they land.
Decisions are recorded in [docs/adr](docs/adr). Everything that needs a real account or key is in [SETUP-NEEDED.md](SETUP-NEEDED.md).

Legend: `[x]` done · `[~]` partly done or limited (see note) · `[ ]` not started

## Approach

1. Build the pure domain first (`packages/core`) behind ports. Every external system (Apaleo, Stripe, Claude and other LLMs, SES, SQS, KMS, Cognito) sits behind an adapter.
2. Every external system has a local stand-in, so the whole product runs with no credentials: a fake Apaleo server, a fake Stripe server driven through the real Stripe SDK, fixture LLM providers, a Postgres-backed queue, a local KMS, a dev auth provider and Mailpit.
3. Real adapters are written against the providers' current docs. Notes are in `docs/adr`.
4. Tests come with every milestone. Domain logic gets unit tests. Repositories, RLS and services get integration tests against real Postgres with pgvector (Testcontainers). The full flow gets a Playwright e2e test.

## Milestones

### M0: Foundation
- [ ] pnpm workspaces + Turborepo, strict TypeScript, Biome lint/format, Vitest
- [ ] docker-compose: Postgres 16 + pgvector, LocalStack, Mailpit; `.env.example`
- [ ] GitHub Actions: lint, typecheck, test, build, `cdk synth`, secrets scan, dependency audit
- [ ] CLAUDE.md, docs/ARCHITECTURE.md, PLAN.md, first ADRs

### M1: Tenancy & auth
- [ ] Organizations, properties, users, memberships (owner/admin/viewer), invitations
- [ ] Auth behind an interface: Cognito (JWKS-verified tokens, hosted UI) and a dev provider
- [ ] Tenancy enforced in the repository layer and by Postgres RLS; cross-tenant tests
- [ ] Audit log for every hotel-side change

### M2: Apaleo integration
- [ ] OAuth 2.0 authorization-code flow, token refresh, KMS envelope-encrypted token storage
- [ ] Idempotent incremental sync of properties, unit groups, rate plans, policies
- [ ] Live offers with all-in totals (taxes and mandatory fees), cancellation policy, short-TTL cache
- [ ] Create and cancel reservations with guest details and payment reference
- [ ] Webhook subscription for reservation changes
- [ ] Fake Apaleo server + fixtures; typed client

### M3: Attribute profile
- [ ] Taxonomy package with ~150 seed attributes
- [ ] Polite website crawl (robots.txt, ≤30 pages, same domain, SSRF-safe)
- [ ] Claude structured-output extraction with evidence → `suggested`
- [ ] PMS → attribute mapping
- [ ] Dashboard editor: bulk approve/reject/edit, provenance badges, completeness score with prioritized gaps
- [ ] Publish step: schema.org JSON-LD snippet + public profile page

### M4: Agent surface (MCP + REST)
- [ ] MCP server at `/mcp` (Streamable HTTP): `search_hotels`, `get_hotel`, `get_offers`, `create_hold`, `get_hold_status`
- [ ] Same capabilities as REST, OpenAPI 3.1 at `/openapi.json`
- [ ] Deterministic, explainable ranking: hard attribute filters + pgvector similarity + price fit
- [ ] Partner API keys, anonymous access with strict rate limits, query/hold logging with no guest PII
- [ ] `scripts/agent-sim.ts`; docs for MCP Inspector and Claude Desktop

### M5: Holds, checkout, payments, reservations
- [ ] Hold TTL (default 15 min); holds live in Lodgent; offer re-verified at payment time
- [ ] Hosted mobile-first checkout `/checkout/[token]` with all-in pricing and Payment Element on the hotel's connected account
- [ ] Prepaid: manual-capture PaymentIntent → Apaleo reservation → capture (cancel on failure); `application_fee_amount`
- [ ] Pay-at-hotel: SetupIntent on the connected account; fee accrues to ledger
- [ ] Idempotency keys, transactional outbox, webhook signature verification, reconciliation job
- [ ] Confirmation page + email; Stripe Connect onboarding (ADR)

### M6: AI visibility monitor
- [ ] Auto-suggested target queries (10–20 per property), editable
- [ ] Scheduled runs across Anthropic, OpenAI, Gemini, Perplexity adapters with web search; per-org monthly cost cap
- [ ] Response parsing: mention (fuzzy name + domain), rank, competitors, cited sources
- [ ] Dashboard: share-of-voice trend, per-provider breakdown, competitors, missing queries, recommendations

### M7: Bookings & fees dashboard
- [ ] Funnel: queries → offers → holds → checkouts → paid → reservations, by agent/provider and over time
- [ ] Bookings list with status and Apaleo link; fees accrued; monthly invoices via Stripe Billing
- [ ] CSV export

### M8: AWS & hardening
- [ ] CDK stacks per environment (dev, prod): VPC, ECS Fargate, ALB + ACM, WAF, RDS, SQS, EventBridge Scheduler, Secrets Manager, KMS, SES, CloudWatch alarms
- [ ] GitHub Actions deploy pipeline via OIDC (defined, never run by Claude)
- [ ] Security pass: authorization tests on every route, input validation, SSRF, secrets scanning, dependency audit
- [ ] Privacy: PII minimization, retention purge job, guest data export/delete endpoints

### M9: Demo & verification
- [ ] Seed: demo org with three boutique hotels on fake Apaleo data
- [ ] Playwright e2e: onboarding → approval → publish → agent-sim hold → checkout → reservation → booking and fee in dashboard
- [ ] README: quick start, env vars, real Apaleo sandbox + Stripe test account, AWS deploy

## Definition of done
- [ ] `pnpm install && docker compose up -d && pnpm dev` runs everything locally with seeded demo data
- [ ] `pnpm test` and `pnpm e2e` pass; CI green; `cdk synth` passes
- [ ] An MCP client can search, get offers and create a hold locally; checkout completes and produces a reservation
- [ ] Dashboard shows attribute profile, visibility results and the booking with its fee
- [ ] SETUP-NEEDED.md lists every external account and key

## Log
- Repository: the session started in an unrelated repo (`townwell`); with the owner's approval Lodgent is built in its own repo.
