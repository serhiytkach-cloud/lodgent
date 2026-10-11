# 0003. Application layer package

Date: 2026-10-11 · Status: accepted

## Context
The spec's layout has `packages/core` (pure domain, no I/O) and adapter packages, with use cases left implicit. The API and the worker both run the same use cases: a webhook and a reconciliation job both finalize a checkout, and both the dashboard and a schedule trigger a PMS sync. Putting use cases in `apps/api` would force the worker to import from another app.

## Decision
Add `packages/application`. It holds the use cases (services), the composition root that wires adapters from config, the AWS adapters (SQS, KMS, SES, Cognito) and the local stand-ins for them. Core stays pure, adapter packages stay provider-specific, and apps stay thin: HTTP/MCP routing in `apps/api`, job dispatch in `apps/worker`.

## Consequences
One more package. Dependency direction: `apps → application → (core, db, apaleo, payments, llm, taxonomy) → shared`. Core depends only on shared.
