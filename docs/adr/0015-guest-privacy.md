# 0015. Guest privacy: export and erasure by email, redaction in place, extended retention

Date: 2026-10-11 · Status: accepted

## Context
Bookings made through AI agents carry a small amount of guest personal data. The data and the existing safeguards:
- **What we hold**: name, email, optional phone and special requests, collected at hosted checkout (ADR 0009).
- **Retention so far**: a daily job already erased these details 30 days after departure.
- **Agent logs**: by design they hold no guest data (ADR 0008).

M8 asks for four things:
- PII minimization;
- no guest PII in agent query logs;
- a retention job;
- export and delete endpoints, so hotels can answer data subject access and erasure requests.

An audit of where guest data actually goes (see [docs/privacy.md](../privacy.md)) found these gaps:
- **Outbox rows**: delivered rows were scrubbed but never deleted. Undeliverable emails kept retrying forever, holding the recipient and guest name. Delivery errors (SES quotes recipient addresses) were stored in `last_error`, even after scrubbing.
- **Job rows**: finished jobs were never deleted, and their error texts were stored verbatim.
- **Agent query log**: it stored the agent's free-text `destination` unmasked; only the client name and UTM fields went through `redactForLog`. Holds stored the raw self-reported client name, while funnel events stored the masked one.
- **Request logs**:
  - full URLs, so the bookings search by surname (`?q=`), signed checkout tokens and the Apaleo webhook secret reached the logs;
  - full client IPs;
  - serialized errors, which can quote email addresses (provider messages, the Apaleo response body kept in `UpstreamError.details`).
- **Pino redaction**: it covered only credentials.

Two systems outside our database also hold the guest's details: the hotel's PMS reservation (Apaleo) and the hotel's Stripe account (receipt email; customer name and email for pay-at-hotel card guarantees). Both belong to the hotel, the controller: the PMS is its system of record and it is the merchant of record in Stripe.

## Decision
- **Endpoints**: `POST /v1/orgs/:orgId/guest-data/export` and `POST /v1/orgs/:orgId/guest-data/erase`.
  - Access: dashboard audience, org auth, permission `guest-data.manage` (owners and admins).
  - POST so the email travels in the body, never in URLs or request logs.
  - Input is validated with shared Zod schemas (`packages/shared/src/api/privacy.ts`). The email is trimmed and lower-cased, then validated.
- **Matching**: case-insensitive on `bookings.guest_email`, within the caller's organization only.
  - The lookup runs in a tenant transaction (RLS plus repository filter), backed by an expression index on `(organization_id, lower(guest_email))`.
  - Another organization's bookings for the same guest are never visible or touched.
- **Export** returns every matching booking: stay, property, amounts as `Money` in minor units, status, contact details and timestamps. It adds notes on retention and on what the PMS and Stripe hold.
- **Erasure redacts in place.** It uses the same operation as the retention job (`bookingRepo.redactGuestData`): guest fields emptied, `pii_redacted_at` set. The booking row stays, because amounts, references, statuses and the fee ledger are needed for the hotel's accounts and for our invoicing, and without the guest fields nothing in them identifies the guest. Rejected: deleting bookings, which would break fee ledgers, invoices and the funnel without removing any more personal data than redaction does.
- **Bookings in checkout are deferred, not erased.** Finalization reads the guest's details to create the PMS reservation and send the confirmation, so a booking in `pending_payment` or `reserving` is excluded.
  - The exclusion is part of the redaction's `WHERE`, so it is atomic with respect to a concurrent claim.
  - Such bookings settle within about an hour: confirmed, or failed by reconciliation. The response counts them as `deferred` and tells the hotel to repeat the erasure.
- **Upcoming and in-house stays are erased, with a warning.** We allow it rather than refusing:
  - the reservation and the hotel's obligations live in the PMS, which keeps its own copy of the guest's details;
  - our copy is not needed for the stay once the reservation exists. The PMS webhook mirror keys on the reservation id, not on guest data.

  The response warns about upcoming stays, the PMS copy, and payment records in the hotel's Stripe account. We do not delete the Stripe customer: it backs the hotel's no-show guarantee, and it is the hotel's data to manage.
- **Unsent confirmation emails** to the erased address in this organization are deleted from the outbox. Sent ones are already scrubbed.
- **Idempotency**: erased bookings no longer match the email, so repeating an erasure is harmless and finishes deferred bookings.
- **Audit without the email.**
  - Both actions write `guest_data.exported` / `guest_data.erased` with entity type `guest` and a pseudonymous reference as the entity id. Each erased booking also gets `booking.guest_data_redacted` with `{trigger: "erasure_request", subject}`.
  - The reference is `g_` plus the first 32 hex digits of HMAC-SHA256 over `orgId + "\n" + email`. Its key is derived from `SIGNING_SECRET` with HKDF (new `Signer.digest`, purpose `guest-ref`).
  - Keyed and per-organization: it cannot be brute-forced from a list of emails without the server secret, and the same guest cannot be correlated across organizations.
  - The optional free-text reason is masked with `redactForLog` before it is stored.
  - Rejected: a masked email such as `a***@example.com`. It still leaks the domain, and it cannot tell apart two guests with similar addresses.
- **Rate limits**:
  - 10 requests per minute per client IP per route (the router's limiter);
  - 60 export and erasure requests per organization per rolling hour, counted from the audit log. This count is durable and shared across API tasks, and caps bulk enumeration from a compromised dashboard account.
- **Retention job** (`privacy.retention`, daily) now also purges:
  - delivered outbox rows after 7 days;
  - emails still undeliverable after 3 days (deleted with recipient and content; a warning with ids only);
  - completed jobs after 7 days and failed jobs after 30;
  - webhook de-duplication rows after 90 days;
  - guest details of failed checkouts 7 days after the failure, which never became reservations.

  Every step deletes or updates in bounded batches, each batch in its own transaction, selecting only rows still due (with `FOR UPDATE SKIP LOCKED` for deletes), so runs are idempotent and safe to overlap. The windows are constants (`RETENTION`) and documented. `PII_RETENTION_DAYS` stays the only knob.
- **Minimization fixes**:
  - the agent query log masks `destination`;
  - holds store the masked client name, which also makes the per-agent funnel labels of holds and events agree;
  - outbox scrubbing clears `last_error`, and delivery and job errors are stored with email addresses masked.
- **Logging** (`packages/application/src/logging.ts`, used by `createContainer`):
  - redaction paths for guest fields and more credentials;
  - a request serializer that redacts path tokens and sensitive query values and truncates IPs (/24, /48);
  - an error serializer that masks email addresses in every string it emits.

## Consequences
- After an erasure, or after retention, a booking shows as "Guest data erased" in the dashboard and on the checkout page. An export for that email returns nothing, because we no longer hold anything linked to it.
- The hotel must still handle the PMS reservation and any Stripe records itself. The dashboard and API say so on every erasure.
- An erasure request for a guest who is mid-checkout needs a second run. The response states it.
- Rotating `SIGNING_SECRET` changes guest references from then on. Earlier audit entries can no longer be matched to new requests by reference, though their booking references stay.
- Request logs no longer show full client IPs or booking search terms. For abuse investigations, ALB/WAF logs keep the full IP under their own retention.
- Migration `0016_guest_privacy` adds two partial indexes on `bookings`: the email lookup, and pending redaction by departure.
