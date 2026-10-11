# 0006. Apaleo integration

Date: 2026-10-11 · Status: accepted

## Context
Apaleo is the first PMS. The spec asks for OAuth authorization-code access, idempotent sync, live all-in offers, reservation create/cancel with a payment reference, webhooks, a fake server, and a typed client generated from Apaleo's OpenAPI specs if practical. It also asks us to check the current docs rather than rely on memory.

## What we verified, and how
The development container's network policy blocks `api.apaleo.com`, `identity.apaleo.com` and `apaleo.dev`, so the Swagger documents could not be downloaded. Instead we read:
- Apaleo's **official generated TypeScript clients** on npm (`@apaleo/angular-api-proxy-booking|inventory|rateplan|finance` 19.0.29, July 2025). Their model and service types are generated from the live OpenAPI specs.
- Apaleo's **official n8n node** (`@apaleo/n8n-nodes-apaleo-official` 1.0.38, October 2026) for the identity endpoints, the account endpoint and the webhook subscription API.
- apaleo.dev guides, via web search.

Findings:
- Identity: `https://identity.apaleo.com/connect/authorize`, `/connect/token`, `/connect/revocation`. Grants: authorization code and client credentials. Scopes include `offline_access`, `setup.read`, `rates.read`, `availability.read`, `reservations.manage`, `folios.manage`. Client authentication is HTTP Basic.
- Current account: `GET /account/v1/accounts/current` returns `{ code, name }`. Its code is the `accountId` in webhook payloads.
- Inventory: `GET /inventory/v1/properties`, `GET /inventory/v1/unit-groups?propertyId=`. Rate plans: `GET /rateplan/v1/rate-plans?propertyId=`, with `minGuaranteeType` (`PM6Hold | CreditCard | Prepayment | Company`), `channelCodes`, `cancellationPolicy` and `includedServices`.
- Offers: `GET /booking/v1/offers?propertyId&arrival&departure&adults&childrenAges&channelCode&unitGroupTypes&timeSliceTemplate`. The response is `StayOffersModel { property, offers: OfferModel[] }`. `OfferModel.totalGrossAmount` is the rate including VAT and included services. `fees` are documented as "added on top of the TotalGrossAmount". `cityTaxes` and mandatory `services` are separate lists. Also on the model: `cancellationFee { code, name, description, dueDateTime, fee }`, `prePaymentAmount`, `timeSlices[].totalGrossAmount` and `validationMessages`.
- Booking: `POST /booking/v1/bookings` accepts an **`Idempotency-Key` header**. The body is `CreateBookingModel { booker, comment, bookerComment, reservations: CreateReservationModel[] }`, where each reservation carries `channelCode`, `source`, `externalCode`, `guaranteeType`, `primaryGuest`, `guestComment`, and `timeSlices: [{ ratePlanId, totalAmount }]`, one per night. The response is `{ id, reservationIds: [{ id }] }`.
- Cancel: `PUT /booking/v1/reservation-actions/{id}/cancel`. Read: `GET /booking/v1/reservations/{id}`.
- Folio payments: `GET /finance/v1/folios?reservationIds=` and `POST /finance/v1/folios/{folioId}/payments` with `{ method, receipt, amount }`. This endpoint also accepts `Idempotency-Key`.
- Webhooks: `POST https://webhook.apaleo.com/v1/subscriptions { endpointUrl, events: ['reservation/*'], propertyIds }` returns `{ id }`. Payloads look like `{ topic, type, id, accountId, propertyId, timestamp }`, and health checks arrive as `topic: system`. We found no payload signature.

## Decision
- **No code generation.** We hand-write Zod schemas for the roughly 15 response shapes we use, mirroring the official models (`packages/apaleo/src/schemas.ts`), so every response is validated at runtime. Schemas are non-strict, so new Apaleo fields don't break parsing. With the specs reachable, `openapi-typescript` generation could replace them later.
- **All-in price** = `totalGrossAmount` + city taxes + `fees` + mandatory `services`. The guest sees one total; the breakdown lists the extras. **Assumption to verify against a sandbox:** that mandatory `services` are not already inside `totalGrossAmount` (the docs say this explicitly only for `fees`). Payment-time re-verification uses the same calculation, so any discrepancy shows up as a price-change error rather than a wrong charge.
- **Channel** `Ibe` by default (`APALEO_CHANNEL_CODE`). Only rate plans distributed on that channel are quoted. Bookings set `source: "Lodgent"` and `externalCode` to our booking reference.
- **Payment mode** follows from the guarantee: `Prepayment` → prepaid; `CreditCard` or `PM6Hold` → pay at hotel, guaranteed by a card the hotel holds through Stripe; `Company` → never sold to agents. A rate plan reaches agents only after the hotel opts in (`exposed_to_agents`).
- **Tokens:** KMS envelope-encrypted, with the encryption context bound to the connection and org. Refreshes are serialized with `SELECT … FOR UPDATE` because Apaleo rotates refresh tokens. If a refresh fails with 400/401, the connection is marked `error` and the hotel is asked to reconnect.
- **Sync** is idempotent. Missing rows are archived, never deleted. A per-row `pms_snapshot` lets re-syncs refresh untouched fields without overwriting hotel edits.
- **Webhooks:** the endpoint URL carries a secret token (`/webhooks/apaleo/:token`). Payloads are only hints: we re-fetch the reservation with our own token, de-duplicate events and process them in a job. If the subscription call fails (for example, a missing scope), a reconciliation job polls the reservations we created instead.
- **Offers** are stored as quotes (`offer_quotes`). Identical searches within `OFFER_CACHE_TTL_SECONDS` (60) reuse them, and holds reference a quote for `OFFER_VALIDITY_MINUTES` (30).
- **Fake server** (`packages/apaleo/src/fake`): the same endpoints, request and response shapes, idempotency, rotating refresh tokens, availability, VAT, city tax, a US destination fee, webhooks and failure injection. It runs in tests and in `pnpm dev` on :4010.

## Consequences
Before production, connect a real Apaleo sandbox (SETUP-NEEDED.md) and verify the all-in assumption, the required scopes (including whatever the webhook API needs), and the `Ibe` channel distribution of the hotel's rate plans.
