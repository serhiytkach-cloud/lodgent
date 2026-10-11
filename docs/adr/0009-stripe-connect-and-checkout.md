# 0009. Payments: Stripe Connect direct charges, hosted checkout, idempotent finalization

Date: 2026-10-11 · Status: accepted

## Context
Guests booked by an AI agent finish on our hosted checkout page. The spec asks for:
- prepaid rates as a manual-capture PaymentIntent with `application_fee_amount`, then the Apaleo reservation, then capture, cancelling on failure;
- pay-at-hotel rates as a SetupIntent, with the fee accruing to a ledger;
- idempotency, an outbox, webhook signature checks, reconciliation and Connect onboarding.

It also asks for this ADR on the account type, and it forbids accepting card data on any endpoint.

Docs check (October 2026): docs.stripe.com is blocked from the build environment. Findings come from the official SDKs' own type definitions and changelogs (`stripe` 23.0.0, `@stripe/stripe-js` 10.0.0, `@stripe/react-stripe-js` 7.0.0):
- The Node SDK pins API version `2026-09-30.endive`. v23 removed `payment_method_types` from PaymentIntent and SetupIntent creation, in favour of `automatic_payment_methods` and `allowed_payment_method_types`.
- For connected-account requests, `stripeContext` is now recommended over `stripeAccount`.
- Accounts are configured with `controller` properties (`stripe_dashboard`, `fees.payer`, `losses.payments`, `requirement_collection`) rather than the legacy `type`.
- `webhooks.constructEvent` and `generateTestHeaderString` remain.
- Stripe.js `confirmPayment`/`confirmSetup` support `redirect: 'if_required'`.

## Decision
- **Account type: Standard-equivalent connected accounts** (`controller.stripe_dashboard.type = full`, `fees.payer = account`, `losses.payments = stripe`, `requirement_collection = stripe`), one per organization, onboarded with hosted Account Links. Hotels get the full Stripe Dashboard and are the merchant of record. They handle refunds, disputes and no-show charges themselves, payouts go straight to them, and Stripe collects KYC. The platform carries no negative-balance liability. Rejected alternatives:
  - Express/Custom with destination charges: these make us merchant of record and liable, and need our own dashboard for refunds.
  - Separate charges and transfers: more moving parts for no benefit here.
- **Direct charges.** Every PaymentIntent and SetupIntent is created on the hotel's account (`stripeContext`). The browser initializes Stripe.js with `stripeAccount` and renders the Payment Element, so card data goes from the guest's browser to Stripe and never reaches our servers.
- **Prepaid:**
  1. A PaymentIntent with `capture_method: manual` authorizes the full amount, carrying `application_fee_amount` (the hold's frozen fee), `automatic_payment_methods: { enabled, allow_redirects: 'never' }` (manual capture and in-page confirmation) and `metadata { bookingId, orgId, holdId }`.
  2. Once authorized, we re-verify the offer (same room and rate, same all-in total).
  3. We create the Apaleo reservation with idempotency key `booking:<id>` and guarantee `Prepayment`.
  4. We capture (`capture:<id>`) and record the payment on the Apaleo folio (`folio:<id>`, retried by a job if needed).

  If re-verification or the reservation fails permanently, the authorization is cancelled and the guest sees that nothing was charged.
- **Pay at hotel:** a SetupIntent (`usage: off_session`) saves the card to a Customer on the hotel's account. The reservation is created with the rate's guarantee (`CreditCard`, or none for 6 pm holds), and its comment points the hotel to the card in their Stripe Dashboard. Our fee goes to `fee_ledger` as `invoice/pending` and is invoiced monthly (M7). If the stay is cancelled, the pending fee is voided.
- **Finalization is one idempotent state machine** (`CheckoutService.finalize`), triggered three ways:
  - the browser after Stripe.js succeeds;
  - the Stripe webhook (via a job);
  - the reconciliation job every 5 minutes.

  It reads payment state from Stripe (never from the webhook payload). A compare-and-set **claim** (`pending_payment → reserving`, or a `reserving` row older than a 2-minute lease) lets one runner proceed at a time without holding a DB transaction across network calls. Transient PMS errors leave the booking `reserving` for a retry with the same idempotency key, for up to 30 minutes; after that the booking fails and the payment is released. Abandoned checkouts are closed and released 15 minutes after the hold expires.
- **Webhooks:** `/webhooks/stripe` verifies the signature over the raw bytes against the platform endpoint secret and the Connect endpoint secret. Events are de-duplicated by id (`webhook_events`) and turned into jobs: `checkout.finalize` for intent events, and `payments.account-updated` (which re-reads the account) for `account.updated`.
- **Holds vs bookings.** The guest's details live on `bookings`, not holds. We keep the minimum the hotel needs: name, email, optional phone and requests. A daily retention job erases them `PII_RETENTION_DAYS` after departure. A hold with a booking in progress is never expired by the hold-expiry job; checkout reconciliation owns it.
- **Card data is never accepted.** Beyond not having such fields, a request guard rejects any request body (REST or MCP) containing a card-like number (issuer prefix, 13–19 digits, Luhn-valid; UUIDs and timestamps excluded) with `card_data_rejected`, before parsing or logging.
- **Local development and tests** use a fake Stripe HTTP server (`packages/payments/src/fake`), driven by the real `stripe` SDK through `host`/`port`. It covers accounts and onboarding links, PaymentIntents (manual capture, fees, cancel), Customers and SetupIntents, idempotency keys and signed webhooks. The checkout shows a simulated payment panel that confirms intents by outcome ("succeed"/"decline") on the fake server, mirroring Stripe.js without any card data. With real test keys the page renders Stripe's Payment Element instead.

## Consequences
- Hotels need a Stripe account (or create one during onboarding) before they can take agent bookings. Until then checkout answers `payments_unavailable`.
- Authorizations hold funds for a few days (card-network dependent). Finalization normally completes in seconds, and reconciliation bounds stalls to minutes.
- Refunds and no-show charges are done by the hotel in their Stripe Dashboard. Fees on refunded prepaid bookings stay collected unless refunded with `refund_application_fee`; reconciling those is a follow-up for M7 invoicing.
- **To verify against a real Apaleo sandbox:** whether `CreditCard` guarantees require payment-account details in the booking request. If they do, pay-at-hotel bookings fall back to the rate's minimum guarantee and the comment (SETUP-NEEDED).
