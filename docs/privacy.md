# Guest privacy: data inventory, retention and requests

This page lists every place guest personal data (PII) can exist in or around Lodgent, why it is there, how long it stays and who can see it. It also covers how hotels answer guests' access and erasure requests. The decisions behind it are in [ADR 0015](adr/0015-guest-privacy.md).

**Roles.** The hotel (the organization) decides what happens to its guests' data: it is the controller. Lodgent processes the data on the hotel's behalf to take the booking. Two systems that hold copies belong to the hotel, not to us:
- the hotel's PMS (Apaleo) is the system of record for reservations;
- the hotel's own Stripe account is the merchant of record for payments.

## What guest data we collect

At hosted checkout the guest gives us only what the hotel needs for the reservation:
- first and last name;
- email;
- optional phone;
- optional special requests.

The guest's acceptance of the terms is timestamped.

We never collect:
- card data: it goes from the guest's browser straight to Stripe's Payment Element, and a request guard rejects card-like numbers on every endpoint (ADR 0009);
- addresses, dates of birth or ID documents;
- anything from the AI agent about the guest: agents get a checkout link and are told not to send guest details.

## Inventory

| Data | Where | Why | Retention | Who can see it |
| --- | --- | --- | --- | --- |
| Guest name, email (lower-cased), phone, special requests, terms timestamp | `bookings` (Postgres, tenant-owned, RLS) | Create the PMS reservation, send the confirmation, let the hotel contact the guest | Erased `PII_RETENTION_DAYS` (default 30) after departure, 7 days after a failed checkout, or immediately on an erasure request. Amounts, dates, references and statuses stay. | Hotel owners and admins (`guest-data.manage`) see contact details. Viewers see names only. Erased rows show "erased". |
| The same details on the checkout page | `/checkout/[token]`, read from `bookings` | The guest reviews their booking | Signed link valid for 90 days (in the confirmation email). Shows nothing once erased. | Whoever holds the link (the guest) |
| Confirmation email: recipient, guest name, stay summary, checkout link | `outbox` payload (`email.send`) | Transactional outbox: the email is sent after the booking commits | Payload replaced with `{scrubbed:true}` and errors cleared as soon as it is delivered. Delivered rows deleted after 7 days. Emails still undeliverable after 3 days are deleted with their content. An erasure request deletes unsent confirmations to that address. | Lodgent operators (database access) |
| Delivery errors | `outbox.last_error`, `jobs.last_error` | Debugging failed sends and jobs | Email addresses are masked before storing. Rows are purged as above; jobs below. | Lodgent operators |
| Job payloads | `jobs` (local Postgres queue), SQS in AWS | Background work | Ids only (org, booking, reservation, crawl). Completed jobs are deleted after 7 days and failed ones after 30. SQS retention is set in CDK. | Lodgent operators |
| Reservation with the guest's name, email, phone and requests (booker/guest comment) | Hotel's PMS (Apaleo) | The hotel's system of record | **Hotel's responsibility.** We never delete or alter it. Erasure responses remind the hotel. | Hotel |
| Receipt email (prepaid). Customer with name and email plus saved card (pay at hotel). | Hotel's Stripe account (direct charges) | Stripe receipt; the hotel's card guarantee for no-shows | **Hotel's responsibility** (merchant of record). Erasure responses remind the hotel. Metadata and descriptions we send hold only ids, the reference, hotel, room type and dates, never guest data. | Hotel |
| Email delivery | SES (AWS) or Mailpit locally | Sending the confirmation | Transient. SES does not keep message content. | — |
| Agent activity | `agent_queries` (system-only), `agent_events` (per hotel) | Ranking analytics and the agent funnel | **No guest data by design** (ADR 0008): coarse destination, dates, party size, attribute codes. Free text (destination, client name, UTM) is masked with `redactForLog`. No IP addresses. Kept indefinitely. | Lodgent operators. Each hotel sees its own funnel events. |
| Holds | `holds` | Room held for checkout | No guest data: offer snapshot, party size, dates, the agent app's masked name | Hotel |
| Audit log | `audit_logs` (tenant-owned) | Accountability for hotel-side changes | **No guest PII.** Booking entries carry ids, references and statuses. Guest data requests carry a pseudonymous guest reference (see below), counts, booking references and a masked reason. Kept for the life of the organization. | Hotel owners and admins |
| Application logs | stdout, then CloudWatch | Operations | **No guest PII**, as described under Logging. Retention is set on the log groups in CDK. | Lodgent operators |
| Webhook de-duplication | `webhook_events` | Process each provider event once | Provider, event id and type only. Deleted after 90 days. | Lodgent operators |
| Offer quotes | `offer_quotes` | Price cache and hold source | No guest data. Deleted 24 hours after expiry. | — |
| Visibility answers | `visibility_results` | AI visibility monitor | About hotels, never guests. Full answers deleted after `VISIBILITY_RAW_RETENTION_DAYS`. | Hotel |

Not guest data, listed for completeness. These are kept while the account exists:
- hotel staff accounts (`users`, `memberships`, `invitations`: email and name; invited emails appear in the audit log);
- organization billing email;
- property contact details;
- partner contact email (`agent_clients`).

## Logging

`packages/application/src/logging.ts` configures the shared pino logger used by the API and the worker:
- **Redaction by path** of credentials (`authorization`, cookies, API keys, tokens, secrets) and of guest fields wherever they appear as a top-level or one-level-nested key: `email`, `guest`, `guestEmail`, `guestFirstName`, `guestLastName`, `guestPhone`, `firstName`, `lastName`, `phone`, `specialRequests`.
- **Request URLs**: path tokens (`/checkout/<token>`, `/invite/<token>`, `/webhooks/apaleo/<secret>`) and the values of `q`, `email`, `phone`, `name`, `code`, `state`, `token` and `key` query parameters are replaced with `[redacted]`. The bookings search by surname therefore never reaches the logs.
- **Client IPs** are truncated to /24 (IPv4) or /48 (IPv6).
- **Errors**: email addresses anywhere in a serialized error are masked. This covers the message, the stack and details such as an upstream response body, since providers quote addresses in error messages.

Request bodies are never logged. Guest data requests carry the email in a POST body, never in the URL.

## Retention job

`privacy.retention` runs daily at 03:30 UTC (`SCHEDULES`; an EventBridge schedule in AWS). It works through these steps in batches of 200, each batch in its own short transaction:

1. Erase guest details on bookings that departed more than `PII_RETENTION_DAYS` ago, and on checkouts that failed more than 7 days ago. Each booking gets an audit entry `booking.guest_data_redacted` with `{trigger: "retention"}`.
2. Delete delivered outbox rows older than 7 days.
3. Delete emails still undeliverable after 3 days, with their recipient and content. This is logged as a warning, with the outbox ids only.
4. Delete jobs that completed more than 7 days ago, or failed more than 30 days ago (local Postgres queue).
5. Delete webhook de-duplication records older than 90 days.

Every step selects only rows still due and is safe to run concurrently or again after a crash. The windows are constants in `RETENTION` (`packages/application/src/services/privacy.ts`); only `PII_RETENTION_DAYS` is configurable.

## Answering a guest's request

Owners and admins open **Settings → Guest data** in the dashboard. The same actions are available on the API (`guest-data.manage`; at most 10 calls per minute per client and 60 per organization per hour):

- **Access**: `POST /v1/orgs/{orgId}/guest-data/export` with `{"email": "…"}`. This returns, as JSON, every booking in this organization made with that email, matched case-insensitively. Each booking includes the stay, property, amounts (minor units), status, contact details and timestamps, plus notes on where else the data lives. The dashboard downloads it as a file. Send it to the guest after verifying their identity.
- **Erasure**: `POST /v1/orgs/{orgId}/guest-data/erase` with `{"email": "…", "reason": "…"}`. This empties the name, email, phone and requests on all of the guest's bookings in this organization, sets `pii_redacted_at`, and deletes unsent confirmation emails.
  - Amounts, dates, references and statuses stay for accounting and fees.
  - Bookings still in checkout (`pending_payment`, `reserving`) are **deferred**: finalization reads the details to create the reservation. They settle within about an hour, then the erasure can be repeated.
  - Upcoming and in-house stays **are** erased. The response warns that the reservation stays valid in the PMS, which keeps its own copy of the guest's details.
  - Erasure is idempotent: erased bookings no longer match the email.
- **Then, in the hotel's own systems**: erase or anonymize the guest in the PMS, and delete the Stripe customer or receipt data in the Stripe Dashboard if the request covers them. Stripe keeps what it must by law.

Both actions are audit-logged as `guest_data.exported` / `guest_data.erased`, with entity type `guest`. The entity id is a **pseudonymous guest reference** `g_<32 hex>`: an HMAC-SHA256 of the organization id and the email, keyed from `SIGNING_SECRET` (HKDF purpose `guest-ref`).
- It is stable within an organization, so repeated requests for the same guest line up.
- It differs across organizations.
- It cannot be reversed or guessed without the server secret.
- The email itself is never stored in the audit log.
- Rotating `SIGNING_SECRET` changes future references.

Requests are scoped to one organization through tenant transactions (RLS plus repository filters). A hotel group can never see or erase another organization's bookings, even for the same guest.
