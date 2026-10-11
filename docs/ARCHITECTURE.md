# Architecture

## Context

```
 AI agents (Claude, ChatGPT, Google AI Mode, partner apps)
        │  MCP (Streamable HTTP, /mcp)   REST (/v1/..., OpenAPI 3.1 at /openapi.json)
        ▼
 ┌─────────────────────────── apps/api (Fastify) ───────────────────────────┐
 │ agent surface · dashboard API · checkout API · Stripe/Apaleo webhooks    │
 └──────────────┬───────────────────────────────────────────┬──────────────┘
                │ packages/application (use cases)          │ outbox → queue
                ▼                                           ▼
        packages/core (pure domain, ports)          apps/worker (SQS consumer, schedules)
                │                                           │
   adapters: packages/apaleo · payments · llm · db · AWS (SQS, KMS, SES, Cognito)
                │
   Apaleo PMS · Stripe Connect · Anthropic/OpenAI/Gemini/Perplexity · Postgres+pgvector

 apps/web (Next.js): hotel dashboard · public hotel profile + JSON-LD · guest checkout (Stripe Payment Element)
```

## Hexagonal layout

- **`packages/core`**: pure domain logic and the ports it needs: ranking, pricing and fees, the hold state machine, completeness scoring, schema.org JSON-LD, PMS→attribute mapping, visibility parsing, query suggestion and funnel math. No I/O, env or clock (callers pass `now`). Unit-tested.
- **Ports** (interfaces in core): `PmsAdapter` (connect, sync, offers, reservations), `PaymentsGateway` (Connect accounts, PaymentIntents, SetupIntents, invoices, webhooks), `ExtractionModel`, `EmbeddingModel`, `VisibilityProvider`, `Mailer`, `JobQueue`, `KeyManagement`, `IdentityProvider`.
- **Adapters**: `packages/apaleo` (PMS), `packages/payments` (Stripe), `packages/llm` (Anthropic, OpenAI, Gemini, Perplexity, embeddings), `packages/db` (Postgres repositories), AWS adapters in `packages/application/src/infra` (SQS, KMS, SES, Cognito).
- **`packages/application`**: use cases that orchestrate core, repositories and adapters, plus the composition root (`createContainer(config)`). The API and worker both use it, so a job and an HTTP request run the same code.

A new PMS (Mews, Cloudbeds) means a new adapter package implementing `PmsAdapter`. Core and application code stay as they are.

## Local stand-ins

Every external dependency has a local implementation. A fresh clone runs end to end with no credentials:

| Dependency | Production | Local / tests |
| --- | --- | --- |
| Apaleo | api.apaleo.com, identity.apaleo.com | fake Apaleo HTTP server (`packages/apaleo/src/fake`), recorded-style fixtures |
| Stripe | api.stripe.com via `stripe` SDK | fake Stripe HTTP server; the real SDK is pointed at it |
| Hotel auth | Amazon Cognito (hosted UI, JWKS) | dev auth provider (email sign-in, HS256 session token) |
| Queue | SQS + EventBridge Scheduler | Postgres-backed queue (`SKIP LOCKED`) + in-process scheduler |
| Token encryption | KMS envelope encryption | local AES-256-GCM master key |
| Email | SES | SMTP → Mailpit |
| LLMs | Anthropic (extraction), Anthropic/OpenAI/Gemini/Perplexity (visibility) | offline keyword extractor; deterministic fixture providers |
| Hotel websites | the hotel's real site | demo sites served by the fake Apaleo server at `/sites/lis/`, `/sites/see/`, `/sites/chs/` |
| Embeddings | OpenAI or Voyage (512 dims) | deterministic local hashing embedder |

## Data and tenancy

- An Organization (hotel group) has Properties, Users through Memberships (owner/admin/viewer), a PMS connection and payment accounts.
- Every tenant-owned row carries `organization_id`. Isolation is enforced twice:
  1. **Repository layer**: tenant repositories take the org from the request context and filter every query by it.
  2. **Postgres RLS**: tenant transactions run `SET LOCAL ROLE lodgent_tenant` and `set_config('app.org_id', …)`. Policies on every tenant table restrict reads and writes to that org. Cross-tenant tests prove that raw SQL in a tenant transaction cannot see or write another org's rows.
- Explicitly cross-tenant paths use the system context: the public agent catalog (published properties only), checkout by token, webhooks and worker scans.
- Money is stored as `bigint` minor units with a currency column. Stay dates are `date` columns interpreted in the property's time zone.

## Key flows

**Agent booking**
1. `search_hotels` → hard filters on approved attributes, pgvector similarity on preferences, price fit from live offers, deterministic tie-break → ranked results with "why".
2. `get_offers` → live Apaleo offers (all-in totals), cached briefly, each stored as an offer quote with an ID.
3. `create_hold` → validates the quote and creates a Hold in Lodgent (not in the PMS) with a TTL (default 15 min). Returns a checkout URL with an unguessable token.
4. The guest opens `/checkout/[token]` and sees hotel branding, stay summary, countdown, all-in total, cancellation policy and terms. Stripe Payment Element runs on the hotel's connected account.
5. Prepaid: a manual-capture PaymentIntent with `application_fee_amount`. On authorization the offer is re-verified, the Apaleo reservation is created, then the payment is captured. If the reservation fails, the authorization is cancelled.
   Pay at hotel: a SetupIntent on the connected account, then the reservation is created. The fee accrues to the ledger and is invoiced monthly.
6. The confirmation page and email show the Apaleo confirmation number. Finalization is idempotent: the client callback and the Stripe webhook both trigger it, and a reconciliation job sweeps stuck states.

**Profile** (ADR 0007)
PMS sync (job `profile.map-pms`) and the website import (job `website.crawl`: polite crawl, Claude extraction, quote verification) produce `suggested` attribute assignments, one row per source, each with evidence. The hotel approves, rejects or sets values in the editor; the effective value is the latest approved one, and the hotel's own value wins ties. Publishing checks readiness, exposes the property to agents, computes its embeddings (job `profile.embed`, re-run on every later change) and generates schema.org JSON-LD and the public profile page `/hotels/[slug]`.

**Visibility**
The worker runs target queries weekly across the configured LLM providers (web-search modes) within each org's cost cap. It parses mentions, rank, competitors and citations, and the dashboard shows share of voice and recommended fixes.

## Reliability

- Idempotency keys on every Stripe and Apaleo write, derived from the hold ID and the step.
- Transactional outbox: domain changes and their side effects (emails, jobs) are committed together and dispatched by the worker.
- Webhook signatures are verified (Stripe) and events are de-duplicated by provider event ID.
- A reconciliation job resolves holds stuck between payment authorization and reservation creation.

## Observability

pino structured JSON logs with request IDs, and OpenTelemetry traces (HTTP, Fastify, pg) exported over OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. CloudWatch alarms are defined in CDK.
