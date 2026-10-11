# 0011. Fees, monthly invoices and the agent funnel

Date: 2026-10-11 · Status: accepted

## Context
Lodgent earns a fee on each booking an AI agent brings: 2% by default, configurable per hotel. ADR 0009 settled how the fee is collected on prepaid bookings: a Stripe application fee on the direct charge. Pay-at-hotel bookings take no money online, so their fee has to be billed. The spec asks for:
- monthly invoices via Stripe Billing;
- a bookings dashboard with status, Apaleo link and fees;
- CSV export;
- a funnel from agent queries to reservations, by agent and over time.

Docs check (October 2026): from the `stripe` 23.0.0 typings:
- `invoices.create` takes `collection_method: 'send_invoice'` with `days_until_due`, and `pending_invoice_items_behavior: 'exclude'`.
- `invoiceItems.create` takes `invoice`, so items attach to one explicit invoice.
- `finalizeInvoice` and `sendInvoice` exist, and Invoice exposes `hosted_invoice_url`, `invoice_pdf` and `status_transitions.paid_at`.

## Decision
- **Who is billed, and how.** Each hotel group (organization) gets a Customer on the **platform** Stripe account (stored as `organizations.stripe_customer_id`). The customer is the billing email, falling back to the owner's email. Invoices are `send_invoice` with 14 days to pay, and Stripe emails the hosted invoice page, where the hotel pays by card or bank transfer.
  - Rejected: debiting the connected account. That is not available for Standard accounts, and it would make fees opaque to hotels.
  - Rejected: charging a saved card automatically. That needs another payment-method collection step in onboarding; it can be added later with `charge_automatically`.
- **When fees are billed.** A pay-at-hotel fee is invoiced once the stay has ended: the run on the first of the month bills every uninvoiced fee for stays that departed before that day. Cancellations before or during the stay void the pending fee (ADR 0009), so they never reach an invoice. Totals under €1 (100 minor units) roll over to the next month. Each currency gets its own invoice, with one line per property.
- **Idempotent, resumable issuing.**
  1. One database transaction creates the `fee_invoices` row (`draft`, unique per organization, period and currency) and locks the fees onto it (`invoiced`, `FOR UPDATE`).
  2. Stripe is called only after that commit, with idempotency keys derived from the row id: create, each line, finalize, send.
  3. If the job dies half-way, the daily billing job finds the `draft` row and resumes it. Stripe replays the steps that already ran, so the invoice never gets duplicate lines.
- **State comes from Stripe, not from webhook payloads.**
  - `invoice.*` events on the platform endpoint, without an `account`, trigger `billing.invoice-sync`, which re-reads the invoice. Events from connected accounts are ignored, since hotels may use Billing for their own customers.
  - The event is mapped to our row by the stored invoice id, or by our id in the invoice metadata, which is verified against the Stripe object.
  - Paid makes the fees `collected`. Void, when the operator voids the invoice in the Stripe Dashboard, waives them.
  - The daily job also re-checks open invoices in case a webhook was lost.
- **Fee rates are an operator setting.** Hotels see their rate; we change it (`pnpm --filter @lodgent/scripts billing set-fee <property> <percent>`, audited). New holds use the new rate. Existing holds and bookings keep the fee they were quoted, because the fee is frozen on the hold.
- **Funnel stages:**

  | Stage | Source |
  | --- | --- |
  | searches | `search_impression` events: the hotel appeared in a search |
  | views | `hotel_view` events |
  | quotes | `offers_view` events |
  | holds | `hold_created` events |
  | checkouts | bookings created: the guest submitted their details |
  | paid | `bookings.payment_authorized_at`, set when finalization first sees the payment authorized or the card saved |
  | reservations | bookings with a PMS reservation |

  - Booking stages are counted on the day checkout started, so each cohort's conversion reads correctly.
  - Agents are labelled by partner name (API key), else by the app's self-reported client name (stored on events, redacted like other agent log text), else as anonymous.
  - Days are cut in the property's time zone; for the whole group, the zone most of its properties share, or UTC when there is no majority.
  - None of it involves guest data.
- **Bookings dashboard.** The list (filters, search by reference, confirmation number or surname, paging) and detail (price breakdown, payment, fee, timeline) read from the booking row plus the hold's frozen offer.
  - Guest email and phone are shown only to roles holding `guest-data.manage`. Viewers see names. Erased data shows as erased.
  - The Apaleo link uses `APALEO_RESERVATION_URL_TEMPLATE`, whose default is to be confirmed (SETUP-NEEDED).
- **CSV exports.**
  - Bookings (no contact details) for everyone who can read bookings. Fee lines for one month for billing roles.
  - Cells that a spreadsheet would treat as a formula are prefixed with an apostrophe, because guest-entered names are attacker-controlled.
  - The web app proxies the download through a route handler, so the session token never reaches the browser.

## Consequences
- Platform fees on pay-at-hotel stays are collected about two to six weeks after the stay. Unpaid invoices are visible in the dashboard and in Stripe, and dunning uses Stripe's invoice reminders.
- Tax on the platform fee (EU VAT reverse charge and similar) must be configured in Stripe Billing before going live (SETUP-NEEDED).
- Refunds of prepaid bookings made by the hotel in its own Stripe Dashboard leave our application fee collected unless refunded with `refund_application_fee`. Reconciling those is not automated yet.
- Funnel events are per hotel and per request. If volume grows, add daily rollups; the queries already aggregate in SQL.
