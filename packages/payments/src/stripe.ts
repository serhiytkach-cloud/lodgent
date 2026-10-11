import {
  type ConnectedAccount,
  type PaymentEvent,
  type PaymentIntentInfo,
  type PaymentProvider,
  type SetupIntentInfo,
  UpstreamError,
  ValidationError,
} from '@lodgent/core';
import Stripe from 'stripe';

export interface StripeProviderOptions {
  secretKey: string;
  publishableKey: string;
  /** Platform-account and Connect webhook endpoint secrets; a signature valid for any of them is accepted. */
  webhookSecrets: string[];
  /** Point the SDK at another host (the local fake Stripe server). */
  apiBaseUrl?: string;
  simulated?: boolean;
}

function toAccount(a: Stripe.Account): ConnectedAccount {
  return {
    id: a.id,
    chargesEnabled: a.charges_enabled ?? false,
    payoutsEnabled: a.payouts_enabled ?? false,
    detailsSubmitted: a.details_submitted ?? false,
    country: a.country ?? null,
    defaultCurrency: a.default_currency?.toUpperCase() ?? null,
    requirementsDue: [...(a.requirements?.currently_due ?? []), ...(a.requirements?.past_due ?? [])],
  };
}

function toPaymentIntent(pi: Stripe.PaymentIntent): PaymentIntentInfo {
  return {
    id: pi.id,
    status: pi.status as PaymentIntentInfo['status'],
    amount: { amount: pi.amount, currency: pi.currency.toUpperCase() },
    amountCapturable: pi.amount_capturable ?? 0,
    clientSecret: pi.client_secret ?? null,
    metadata: { ...(pi.metadata ?? {}) },
    lastError: pi.last_payment_error?.message ?? null,
  };
}

function toSetupIntent(si: Stripe.SetupIntent): SetupIntentInfo {
  const id = (v: string | { id: string } | null | undefined) => (typeof v === 'string' ? v : (v?.id ?? null));
  return {
    id: si.id,
    status: si.status as SetupIntentInfo['status'],
    clientSecret: si.client_secret ?? null,
    paymentMethodId: id(si.payment_method),
    customerId: id(si.customer),
    metadata: { ...(si.metadata ?? {}) },
    lastError: si.last_setup_error?.message ?? null,
  };
}

/**
 * Stripe Connect with direct charges on the hotel's account (ADR 0009). Every mutating call carries
 * an idempotency key so retries after timeouts never double-charge.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly publishableKey: string;
  readonly simulated: boolean;
  private readonly stripe: Stripe;
  private readonly webhookSecrets: string[];

  constructor(options: StripeProviderOptions) {
    const base = options.apiBaseUrl ? new URL(options.apiBaseUrl) : null;
    this.stripe = new Stripe(options.secretKey, {
      maxNetworkRetries: 2,
      timeout: 20_000,
      appInfo: { name: 'Lodgent' },
      ...(base
        ? {
            host: base.hostname,
            port: base.port || (base.protocol === 'https:' ? 443 : 80),
            protocol: base.protocol.replace(':', '') as 'http' | 'https',
          }
        : {}),
    });
    this.publishableKey = options.publishableKey;
    this.webhookSecrets = options.webhookSecrets.filter(Boolean);
    this.simulated = options.simulated ?? false;
  }

  private async call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Stripe.errors.StripeError) {
        throw new UpstreamError('stripe', `Stripe ${what} failed: ${error.message}`, {
          status: error.statusCode ?? null,
          stripeCode: error.code ?? null,
          stripeType: error.type,
        });
      }
      throw error;
    }
  }

  async createConnectedAccount(input: {
    email: string | null;
    country: string | null;
    metadata: Record<string, string>;
  }) {
    const account = await this.call('account creation', () =>
      this.stripe.accounts.create({
        // Standard-style account: the hotel has the full Stripe Dashboard, pays Stripe's fees and
        // handles refunds and disputes as merchant of record; Stripe collects requirements.
        controller: {
          stripe_dashboard: { type: 'full' },
          fees: { payer: 'account' },
          losses: { payments: 'stripe' },
          requirement_collection: 'stripe',
        },
        ...(input.email ? { email: input.email } : {}),
        ...(input.country ? { country: input.country } : {}),
        metadata: input.metadata,
      }),
    );
    return toAccount(account);
  }

  async getConnectedAccount(accountId: string) {
    return toAccount(await this.call('account lookup', () => this.stripe.accounts.retrieve(accountId)));
  }

  async createOnboardingLink(input: { accountId: string; refreshUrl: string; returnUrl: string }) {
    const link = await this.call('onboarding link', () =>
      this.stripe.accountLinks.create({
        account: input.accountId,
        refresh_url: input.refreshUrl,
        return_url: input.returnUrl,
        type: 'account_onboarding',
      }),
    );
    return link.url;
  }

  async createPaymentIntent(input: Parameters<PaymentProvider['createPaymentIntent']>[0]) {
    const pi = await this.call('payment creation', () =>
      this.stripe.paymentIntents.create(
        {
          amount: input.amount.amount,
          currency: input.amount.currency.toLowerCase(),
          // Authorize now, capture only once the hotel's PMS has confirmed the reservation.
          capture_method: 'manual',
          application_fee_amount: input.applicationFee.amount,
          // Cards and wallets confirm in-page; redirect-based methods can't be captured manually.
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          description: input.description,
          ...(input.statementDescriptorSuffix
            ? { statement_descriptor_suffix: input.statementDescriptorSuffix.slice(0, 22) }
            : {}),
          ...(input.receiptEmail ? { receipt_email: input.receiptEmail } : {}),
          metadata: input.metadata,
        },
        { stripeContext: input.accountId, idempotencyKey: input.idempotencyKey },
      ),
    );
    return toPaymentIntent(pi);
  }

  async getPaymentIntent(accountId: string, id: string) {
    return toPaymentIntent(
      await this.call('payment lookup', () =>
        this.stripe.paymentIntents.retrieve(id, {}, { stripeContext: accountId }),
      ),
    );
  }

  async capturePaymentIntent(accountId: string, id: string, idempotencyKey: string) {
    return toPaymentIntent(
      await this.call('capture', () =>
        this.stripe.paymentIntents.capture(id, {}, { stripeContext: accountId, idempotencyKey }),
      ),
    );
  }

  async cancelPaymentIntent(accountId: string, id: string, idempotencyKey: string) {
    return toPaymentIntent(
      await this.call('cancellation', () =>
        this.stripe.paymentIntents.cancel(id, {}, { stripeContext: accountId, idempotencyKey }),
      ),
    );
  }

  async createSetupIntent(input: Parameters<PaymentProvider['createSetupIntent']>[0]) {
    const opts = { stripeContext: input.accountId };
    // The card is saved to a customer on the hotel's account so the hotel can charge no-shows.
    const customer = await this.call('customer creation', () =>
      this.stripe.customers.create(
        { email: input.customer.email, name: input.customer.name, metadata: input.metadata },
        { ...opts, idempotencyKey: `${input.idempotencyKey}:customer` },
      ),
    );
    const si = await this.call('card setup', () =>
      this.stripe.setupIntents.create(
        {
          customer: customer.id,
          usage: 'off_session',
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          description: input.description,
          metadata: input.metadata,
        },
        { ...opts, idempotencyKey: input.idempotencyKey },
      ),
    );
    return toSetupIntent(si);
  }

  async getSetupIntent(accountId: string, id: string) {
    return toSetupIntent(
      await this.call('card setup lookup', () =>
        this.stripe.setupIntents.retrieve(id, {}, { stripeContext: accountId }),
      ),
    );
  }

  parseWebhook(rawBody: Buffer, signature: string): PaymentEvent {
    let event: Stripe.Event | null = null;
    for (const secret of this.webhookSecrets) {
      try {
        event = this.stripe.webhooks.constructEvent(rawBody, signature, secret);
        break;
      } catch {
        // try the next endpoint secret
      }
    }
    if (!event) throw new ValidationError('Invalid Stripe signature');
    const accountId = event.account ?? null;
    if (event.type.startsWith('payment_intent.')) {
      const pi = event.data.object as Stripe.PaymentIntent;
      return {
        id: event.id,
        type: 'payment_intent.updated',
        accountId,
        paymentIntentId: pi.id,
        status: pi.status as PaymentIntentInfo['status'],
        metadata: { ...(pi.metadata ?? {}) },
      };
    }
    if (event.type.startsWith('setup_intent.')) {
      const si = event.data.object as Stripe.SetupIntent;
      return {
        id: event.id,
        type: 'setup_intent.updated',
        accountId,
        setupIntentId: si.id,
        status: si.status as SetupIntentInfo['status'],
        metadata: { ...(si.metadata ?? {}) },
      };
    }
    if (event.type === 'account.updated') {
      return {
        id: event.id,
        type: 'account.updated',
        accountId: accountId ?? (event.data.object as Stripe.Account).id,
      };
    }
    return { id: event.id, type: 'ignored', eventType: event.type };
  }

  /** Signs a payload the way Stripe does (tests and the fake server). */
  static signatureHeader(payload: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
    return Stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp });
  }
}
