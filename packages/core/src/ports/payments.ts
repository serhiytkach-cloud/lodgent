import type { Money } from '@lodgent/shared';

/**
 * Payment provider port (Stripe Connect). Hotels are the merchant of record: charges are created
 * on the hotel's connected account (direct charges) and the platform takes an application fee.
 * Card data never touches our servers; the browser sends it straight to the provider.
 */

export interface ConnectedAccount {
  id: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  country: string | null;
  defaultCurrency: string | null;
  /** Requirement codes the account still has to provide. */
  requirementsDue: string[];
}

export type PaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'canceled'
  | 'succeeded';

export interface PaymentIntentInfo {
  id: string;
  status: PaymentIntentStatus;
  amount: Money;
  amountCapturable: number;
  clientSecret: string | null;
  metadata: Record<string, string>;
  lastError: string | null;
}

export type SetupIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'canceled'
  | 'succeeded';

export interface SetupIntentInfo {
  id: string;
  status: SetupIntentStatus;
  clientSecret: string | null;
  paymentMethodId: string | null;
  customerId: string | null;
  metadata: Record<string, string>;
  lastError: string | null;
}

export type BillingInvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';

/** A platform invoice to a hotel group (Stripe Billing on the platform account). */
export interface BillingInvoiceInfo {
  id: string;
  number: string | null;
  status: BillingInvoiceStatus;
  currency: string;
  amountDue: number;
  amountPaid: number;
  hostedUrl: string | null;
  pdfUrl: string | null;
  dueAt: Date | null;
  paidAt: Date | null;
  metadata: Record<string, string>;
}

/** A provider webhook event, verified and reduced to what we act on. */
export type PaymentEvent =
  | {
      id: string;
      type: 'payment_intent.updated';
      accountId: string | null;
      paymentIntentId: string;
      status: PaymentIntentStatus;
      metadata: Record<string, string>;
    }
  | {
      id: string;
      type: 'setup_intent.updated';
      accountId: string | null;
      setupIntentId: string;
      status: SetupIntentStatus;
      metadata: Record<string, string>;
    }
  | { id: string; type: 'account.updated'; accountId: string }
  | { id: string; type: 'invoice.updated'; invoiceId: string; metadata: Record<string, string> }
  | { id: string; type: 'ignored'; eventType: string };

export interface PaymentProvider {
  readonly name: string;
  /** Browser-side key (Stripe.js). */
  readonly publishableKey: string;
  /** Local development: the provider is the fake server and the checkout shows a simulated payment panel. */
  readonly simulated: boolean;

  createConnectedAccount(input: {
    email: string | null;
    country: string | null;
    metadata: Record<string, string>;
  }): Promise<ConnectedAccount>;
  getConnectedAccount(accountId: string): Promise<ConnectedAccount>;
  /** Hosted onboarding link (single use, short-lived). */
  createOnboardingLink(input: { accountId: string; refreshUrl: string; returnUrl: string }): Promise<string>;

  createPaymentIntent(input: {
    accountId: string;
    amount: Money;
    applicationFee: Money;
    description: string;
    statementDescriptorSuffix: string | null;
    receiptEmail: string | null;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<PaymentIntentInfo>;
  getPaymentIntent(accountId: string, id: string): Promise<PaymentIntentInfo>;
  capturePaymentIntent(accountId: string, id: string, idempotencyKey: string): Promise<PaymentIntentInfo>;
  cancelPaymentIntent(accountId: string, id: string, idempotencyKey: string): Promise<PaymentIntentInfo>;

  createSetupIntent(input: {
    accountId: string;
    customer: { email: string; name: string };
    description: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<SetupIntentInfo>;
  getSetupIntent(accountId: string, id: string): Promise<SetupIntentInfo>;

  // ---- Billing: the platform invoices hotel groups for pay-at-hotel fees -------------------
  /** A customer on the platform account for the hotel group (created once, then reused). */
  createBillingCustomer(input: {
    name: string;
    email: string | null;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<string>;
  /**
   * Creates, finalizes and emails an invoice with the given lines, payable on the hosted invoice
   * page. Every step is idempotent on `idempotencyKey`, so a retry continues where it stopped.
   */
  issueInvoice(input: {
    customerId: string;
    currency: string;
    description: string;
    lines: { amount: number; description: string }[];
    daysUntilDue: number;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<BillingInvoiceInfo>;
  getInvoice(id: string): Promise<BillingInvoiceInfo>;

  /** Verifies the signature over the exact request bytes. Throws on a bad signature. */
  parseWebhook(rawBody: Buffer, signature: string): PaymentEvent;
}
