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
- [x] pnpm workspaces + Turborepo, strict TypeScript, Biome lint/format, Vitest
- [x] docker-compose: Postgres 16 + pgvector, LocalStack, Mailpit; `.env.example`
- [x] GitHub Actions: lint, typecheck, test, build, `cdk synth`, secrets scan, dependency audit
- [x] CLAUDE.md, docs/ARCHITECTURE.md, PLAN.md, first ADRs

### M1: Tenancy & auth
- [x] Organizations, properties, users, memberships (owner/admin/viewer), invitations
- [x] Auth behind an interface: Cognito (JWKS-verified tokens, hosted UI) and a dev provider
- [x] Tenancy enforced in the repository layer and by Postgres RLS; cross-tenant tests
- [x] Audit log for every hotel-side change
- [x] Dashboard: sign-in (dev + Cognito PKCE), onboarding, properties, team/invitations, settings, audit log
- [x] Worker: outbox dispatcher, Postgres/SQS job runners, local scheduler

### M2: Apaleo integration
- [x] OAuth 2.0 authorization-code flow, token refresh (serialized; Apaleo rotates refresh tokens), KMS envelope-encrypted token storage
- [x] Idempotent sync of properties, unit groups, rate plans, cancellation policies (hotel edits preserved)
- [x] Live offers with all-in totals (VAT, city tax, mandatory fees), cancellation policy, short-TTL quote cache
- [x] Create and cancel reservations with guest details and payment reference; folio payment posting (adapter; used in M5)
- [x] Webhook subscription + receiver (secret URL, de-duplication, job). Reservation status updates are applied in M5
- [x] Fake Apaleo server + fixtures (3 boutique hotels). Zod-validated client instead of codegen (ADR 0006: specs unreachable from the build environment)
- [x] Dashboard: Connections page (connect/sync/disconnect), Rooms & rates with per-rate-plan agent opt-in and live offer preview

### M3: Attribute profile
- [x] Taxonomy package with ~150 seed attributes (153 across 11 categories, synonyms, schema.org mapping)
- [x] Polite website crawl (robots.txt, ≤30 pages, same domain, SSRF-safe)
- [x] Claude structured-output extraction with evidence → `suggested` (quotes verified against the page; offline keyword matcher without a key)
- [x] PMS → attribute mapping
- [x] Dashboard editor: bulk approve/reject/edit, provenance badges, completeness score with prioritized gaps
- [x] Publish step: schema.org JSON-LD snippet + public profile page
- [x] Demo hotel websites on the fake server (`/sites/lis|see|chs/`) for local imports
- [x] Embeddings (pgvector, 512 dims) refreshed on publish and on profile changes

### M4: Agent surface (MCP + REST)
- [x] MCP server at `/mcp` (Streamable HTTP, SDK v2, stateless): `search_hotels`, `get_hotel`, `get_offers`, `create_hold`, `get_hold_status` (ADR 0008)
- [x] Same capabilities as REST, OpenAPI 3.1 at `/openapi.json`
- [x] Deterministic, explainable ranking: hard attribute filters + pgvector similarity + price fit
- [x] Partner API keys (`partner-key` CLI), anonymous access with strict rate limits, query/hold logging with no guest PII
- [x] `scripts/agent-sim.ts`; docs for MCP Inspector, Claude Code and Claude Desktop (`docs/agents.md`)
- [x] Holds (TTL, live re-check, per-room-type locking, signed checkout link) and the hold-expiry job

### M5: Holds, checkout, payments, reservations
- [x] Hold TTL (default 15 min); holds live in Lodgent; offer re-verified at payment time
- [x] Hosted mobile-first checkout `/checkout/[token]` with all-in pricing and Payment Element on the hotel's connected account (simulated panel with the local fake Stripe)
- [x] Prepaid: manual-capture PaymentIntent → Apaleo reservation → capture (cancel on failure); `application_fee_amount`; folio payment posted
- [x] Pay-at-hotel: SetupIntent on the connected account; fee accrues to ledger
- [x] Idempotency keys, transactional outbox, webhook signature verification, reconciliation job
- [x] Confirmation page + email; Stripe Connect onboarding (ADR 0009)
- [x] Fake Stripe server driven by the real SDK; card-data request guard; PMS reservation changes mirrored; guest-data retention job

### M6: AI visibility monitor
- [x] Auto-suggested target queries (up to 10 seeded, 20 active per property), editable
- [x] Scheduled runs across Anthropic, OpenAI, Gemini, Perplexity adapters with web search; per-org monthly cost cap (ADR 0010)
- [x] Response parsing: mention (fuzzy name + domain), rank, competitors, cited sources
- [x] Dashboard: share-of-voice trend, per-provider breakdown, competitors, missing queries, recommendations

### M7: Bookings & fees dashboard
- [x] Funnel: queries → offers → holds → checkouts → paid → reservations, by agent/provider and over time
- [x] Bookings list with status and Apaleo link; fees accrued; monthly invoices via Stripe Billing (ADR 0011)
- [x] CSV export (bookings; fee lines per month), spreadsheet-formula safe
- [x] Operator CLI for per-property fee rates and invoicing a month on demand

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
