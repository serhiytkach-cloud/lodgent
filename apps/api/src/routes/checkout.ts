import type { Container } from '@lodgent/application';
import { CheckoutDto, CheckoutGuestInput, PaymentAccountDto } from '@lodgent/shared';
import { z } from 'zod';
import type { Router } from '../http/router';

const TokenParams = z.object({ token: z.string().min(10).max(600) });

/** Guest checkout (token in the URL is the capability), hotel payment settings, Stripe webhooks. */
export function registerCheckoutRoutes(router: Router, container: Container): void {
  const { checkout, paymentAccounts, paymentWebhooks } = container.services;
  const guest = { tags: ['checkout'], audience: 'checkout', auth: 'none', rateLimitPerMinute: 60 } as const;

  router.add({
    ...guest,
    method: 'GET',
    path: '/v1/checkout/:token',
    operationId: 'getCheckout',
    summary: 'Checkout page data for a hold',
    params: TokenParams,
    response: CheckoutDto,
    handler: async ({ params }) => checkout.view(params.token),
  });

  router.add({
    ...guest,
    method: 'POST',
    path: '/v1/checkout/:token/guest',
    operationId: 'startCheckout',
    summary: 'Submit guest details and open the payment',
    description:
      'Stores the guest’s name and contact details and creates the payment (or card guarantee) on the hotel’s Stripe account. Card details are entered in Stripe’s fields in the browser and never reach this API.',
    rateLimitPerMinute: 20,
    params: TokenParams,
    body: CheckoutGuestInput,
    response: CheckoutDto,
    handler: async ({ params, body }) => checkout.start(params.token, body),
  });

  router.add({
    ...guest,
    method: 'POST',
    path: '/v1/checkout/:token/complete',
    operationId: 'completeCheckout',
    summary: 'Confirm the booking after the payment succeeded in the browser',
    rateLimitPerMinute: 30,
    params: TokenParams,
    response: CheckoutDto,
    handler: async ({ params }) => checkout.complete(params.token),
  });

  const org = { tags: ['payments'], audience: 'dashboard', auth: 'org' } as const;
  const OrgParams = z.object({ orgId: z.uuid() });

  router.add({
    ...org,
    method: 'GET',
    path: '/v1/orgs/:orgId/payments',
    operationId: 'getPaymentAccount',
    summary: 'Stripe connection status',
    permission: 'org.read',
    params: OrgParams,
    response: PaymentAccountDto,
    handler: async ({ org: ctx }) => paymentAccounts.get(ctx),
  });

  router.add({
    ...org,
    method: 'POST',
    path: '/v1/orgs/:orgId/payments/onboarding',
    operationId: 'startPaymentOnboarding',
    summary: 'Connect Stripe: returns a hosted onboarding link',
    permission: 'payments.manage',
    rateLimitPerMinute: 10,
    params: OrgParams,
    response: z.object({ url: z.string() }),
    handler: async ({ org: ctx }) => paymentAccounts.startOnboarding(ctx),
  });

  router.add({
    ...org,
    method: 'POST',
    path: '/v1/orgs/:orgId/payments/refresh',
    operationId: 'refreshPaymentAccount',
    summary: 'Re-read the Stripe account status',
    permission: 'org.read',
    rateLimitPerMinute: 20,
    params: OrgParams,
    response: PaymentAccountDto,
    handler: async ({ org: ctx }) => paymentAccounts.refresh(ctx),
  });

  router.add({
    method: 'POST',
    path: '/webhooks/stripe',
    operationId: 'stripeWebhook',
    summary: 'Stripe webhook receiver (platform and Connect events)',
    tags: ['webhooks'],
    audience: 'webhook',
    auth: 'none',
    rateLimitPerMinute: 3000,
    rawBody: true,
    response: z.object({ received: z.boolean(), duplicate: z.boolean().optional() }),
    handler: async ({ req }) =>
      paymentWebhooks.handle(req.rawBody ?? Buffer.alloc(0), String(req.headers['stripe-signature'] ?? '')),
  });
}
