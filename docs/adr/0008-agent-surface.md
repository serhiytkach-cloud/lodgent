# 0008. Agent surface: MCP SDK v2, one service behind MCP and REST, explainable ranking

Date: 2026-10-11 · Status: accepted

## Context
AI agents need to search hotels, read profiles, get live offers, hold a room and follow the hold. The spec asks for an MCP server at `/mcp` (Streamable HTTP) with the official SDK, the same capabilities over REST with OpenAPI 3.1, deterministic and explainable ranking, partner keys with anonymous access under strict limits, and logging without guest PII.

Checked in October 2026: the official TypeScript SDK's current line is **v2** (`@modelcontextprotocol/server` 2.3.1, `/client` 2.3.1, `/node` 2.1.1, `/fastify` 2.0.1). It implements the 2026-07-28 protocol and still serves 2025-era clients. v1 (`@modelcontextprotocol/sdk` 1.32) is the previous line. Sources: the package READMEs and https://ts.sdk.modelcontextprotocol.io/v2/ (Tools, Serve over HTTP, Serve with Fastify, Errors, Test a server).

## Decision
- **SDK v2, stateless.** `createMcpHandler(factory)` builds a fresh `McpServer` per request; nothing is held between requests, so the API scales horizontally behind the load balancer with no session affinity. Legacy (2025-era) requests are served statelessly by the same factory (the SDK default).
- **Mounted inside our Fastify app**, not a separate server. The `/mcp` route resolves the partner key first, converts the Fastify request into a web `Request` (passing the already-parsed body) and calls `handler.fetch(request, { authInfo })`; the caller travels as `authInfo.extra`. CORS, security headers, request ids, rate limits and error handling therefore apply to MCP exactly as to REST. We don't use `createMcpFastifyApp`'s Host/Origin validation: it guards localhost servers against DNS rebinding, while ours is a public, cookie-less API whose tools are public anyway.
- **One application service** (`AgentService`) backs both MCP tools and REST endpoints, and **one set of Zod schemas** (`packages/shared/src/api/agent.ts`) backs MCP `inputSchema`/`outputSchema`, REST validation and the OpenAPI document. Tool results return a short readable summary plus the JSON payload in `content` (for hosts that only show text) and the same payload as `structuredContent`. Domain errors become `isError` results with an actionable message (`offer_expired: … call get_offers again`).
- **Ranking** (`packages/core/src/ranking.ts`, pure):
  1. Hard filters on approved values: must-have requirements (at hotel level, or a room type that also fits the party), capacity, at least one sellable room, and availability when dates are given.
  2. Weighted score: semantic similarity of the free-text preferences to the hotel's embeddings (0.4), share of nice-to-haves met (0.25), price fit against the budget or the cheapest result (0.25), profile completeness (0.1). Absent components drop out and the weights renormalize.
  3. Ties break on price, name, id, so the same input always gives the same order.
  4. Every result carries plain-language reasons built from the same components.

  With dates, only the 12 best candidates are priced live (four at a time, using the 60 s offer cache) to bound PMS load.
- **Requirements in plain words.** Agents send phrases ("dog friendly"), which the taxonomy maps to codes, with alternatives (`pets_allowed` or `dogs_allowed`) and enum values ("free parking" → `parking = free`). Unmapped phrases become soft preferences, and the response shows the interpretation.
- **Holds** live in Lodgent, not the PMS: TTL 15 min, price/fee/offer snapshot frozen on the hold. A quote older than the cache window is re-checked live first: unavailable → `offer_unavailable`; price moved → `price_changed` with the new offer id. Concurrent holds are serialized per room type (row lock) and capped at the PMS's available units. The checkout link is a signed token (HMAC, per-purpose key) carrying the hold id.
- **Partners and limits.** A partner key (`X-Api-Key` or Bearer) gets a per-key budget; everyone else gets a stricter per-IP budget. An invalid key is a 401, and rate limiting puts invalid keys in the IP bucket, so rotating fake keys gains nothing.
- **Privacy.** `agent_queries` (system-only) stores the tool, a redacted coarse destination, dates, party size, interpreted codes, a has-preferences flag, counts, latency, partner and UTM. It never stores free text, guest names, contact details or IP addresses. Per-hotel funnel events (`agent_events`) are tenant-owned, so each hotel sees only its own.

## Consequences
- MCP and REST cannot drift: a schema change shows up in both and in `/openapi.json`; integration tests drive both, the MCP side through the official client on both protocol eras.
- Stateless MCP means no server-initiated notifications between requests; nothing in this flow needs them.
- Ranking quality depends on embeddings: the local hash embedder (dev/test) is deterministic but weak, and production should set `EMBEDDINGS_PROVIDER` (SETUP-NEEDED #6).
- Holds don't block PMS inventory. The PMS stays the source of truth, and checkout (M5) re-verifies the offer before creating the reservation.
