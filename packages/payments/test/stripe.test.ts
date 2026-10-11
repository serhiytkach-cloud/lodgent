import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type PaymentEvent, UpstreamError, ValidationError } from '@lodgent/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeStripe, type FakeStripe } from '../src/fake/server';
import { StripePaymentProvider } from '../src/stripe';

const SECRET = 'whsec_test_secret_123';
let fake: FakeStripe;
let provider: StripePaymentProvider;
let hook: Server;
const received: PaymentEvent[] = [];

beforeAll(async () => {
  // A tiny webhook receiver that verifies signatures with the real SDK.
  hook = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        received.push(provider.parseWebhook(Buffer.concat(chunks), String(req.headers['stripe-signature'])));
        res.writeHead(200).end();
      } catch {
        res.writeHead(400).end();
      }
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
  fake = createFakeStripe({
    secretKey: 'sk_test_contract',
    webhookSecret: SECRET,
    webhookUrl: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/`,
  });
  await fake.app.listen({ port: 0, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${(fake.app.server.address() as AddressInfo).port}`;
  fake.setPublicUrl(url);
  provider = new StripePaymentProvider({
    secretKey: 'sk_test_contract',
    publishableKey: 'pk_test_contract',
    webhookSecrets: ['whsec_other', SECRET],
    apiBaseUrl: url,
    simulated: true,
  });
});

afterAll(async () => {
  await fake.app.close();
  await new Promise<void>((r) => hook.close(() => r()));
});

describe('Stripe provider against the fake Stripe API (real SDK)', () => {
  let accountId: string;

  it('creates a connected account and an onboarding link', async () => {
    const account = await provider.createConnectedAccount({
      email: 'hotel@example.com',
      country: 'PT',
      metadata: { orgId: 'o1' },
    });
    accountId = account.id;
    expect(account).toMatchObject({ chargesEnabled: false, country: 'PT', defaultCurrency: 'EUR' });
    expect(account.requirementsDue.length).toBeGreaterThan(0);
    const link = await provider.createOnboardingLink({
      accountId,
      refreshUrl: 'http://web/refresh',
      returnUrl: 'http://web/return',
    });
    expect(link).toContain(`/_fake/onboarding/${accountId}`);

    // Charging before onboarding fails cleanly.
    await expect(
      provider.createPaymentIntent({
        accountId,
        amount: { amount: 10_000, currency: 'EUR' },
        applicationFee: { amount: 200, currency: 'EUR' },
        description: 'x',
        statementDescriptorSuffix: null,
        receiptEmail: null,
        metadata: {},
        idempotencyKey: 'early',
      }),
    ).rejects.toBeInstanceOf(UpstreamError);

    await fake.completeOnboarding(accountId);
    expect(await provider.getConnectedAccount(accountId)).toMatchObject({
      chargesEnabled: true,
      requirementsDue: [],
    });
    expect(received.some((e) => e.type === 'account.updated' && e.accountId === accountId)).toBe(true);
  });

  it('authorizes with manual capture and an application fee, idempotently, then captures', async () => {
    const input = {
      accountId,
      amount: { amount: 41_250, currency: 'EUR' },
      applicationFee: { amount: 825, currency: 'EUR' },
      description: 'Casa Azul Lisboa, 2 nights',
      statementDescriptorSuffix: 'CASA AZUL',
      receiptEmail: 'guest@example.com',
      metadata: { bookingId: 'b1' },
      idempotencyKey: 'pi:b1',
    };
    const pi = await provider.createPaymentIntent(input);
    const again = await provider.createPaymentIntent(input);
    expect(again.id).toBe(pi.id);
    expect(pi).toMatchObject({
      status: 'requires_payment_method',
      amount: { amount: 41_250, currency: 'EUR' },
    });
    expect(pi.clientSecret).toMatch(new RegExp(`^${pi.id}_secret_`));
    const created = fake.state.objects.get(pi.id)!;
    expect(created).toMatchObject({
      capture_method: 'manual',
      application_fee_amount: 825,
      _account: accountId,
    });

    const declined = await fake.confirm(pi.clientSecret!, 'decline');
    expect(declined.error).toBeDefined();
    expect((await provider.getPaymentIntent(accountId, pi.id)).lastError).toBe('Your card was declined.');

    await fake.confirm(pi.clientSecret!, 'succeed');
    const authorized = await provider.getPaymentIntent(accountId, pi.id);
    expect(authorized).toMatchObject({ status: 'requires_capture', amountCapturable: 41_250 });
    expect(
      received.find(
        (e) =>
          e.type === 'payment_intent.updated' &&
          e.paymentIntentId === pi.id &&
          e.status === 'requires_capture',
      ),
    ).toMatchObject({
      accountId,
      metadata: { bookingId: 'b1' },
    });

    const captured = await provider.capturePaymentIntent(accountId, pi.id, 'capture:b1');
    expect(captured.status).toBe('succeeded');
    // Retrying the capture with the same key replays the result instead of failing.
    expect((await provider.capturePaymentIntent(accountId, pi.id, 'capture:b1')).status).toBe('succeeded');
    await expect(provider.cancelPaymentIntent(accountId, pi.id, 'cancel:b1')).rejects.toBeInstanceOf(
      UpstreamError,
    );
  });

  it('cancels an authorization', async () => {
    const pi = await provider.createPaymentIntent({
      accountId,
      amount: { amount: 9_900, currency: 'EUR' },
      applicationFee: { amount: 198, currency: 'EUR' },
      description: 'x',
      statementDescriptorSuffix: null,
      receiptEmail: null,
      metadata: {},
      idempotencyKey: 'pi:b2',
    });
    await fake.confirm(pi.clientSecret!);
    expect((await provider.cancelPaymentIntent(accountId, pi.id, 'cancel:b2')).status).toBe('canceled');
  });

  it('saves a card for pay-at-hotel bookings', async () => {
    const si = await provider.createSetupIntent({
      accountId,
      customer: { email: 'guest@example.com', name: 'Ana Silva' },
      description: 'Guarantee',
      metadata: { bookingId: 'b3' },
      idempotencyKey: 'si:b3',
    });
    expect(si).toMatchObject({
      status: 'requires_payment_method',
      customerId: expect.stringMatching(/^cus_/),
    });
    await fake.confirm(si.clientSecret!);
    const done = await provider.getSetupIntent(accountId, si.id);
    expect(done).toMatchObject({ status: 'succeeded', paymentMethodId: expect.stringMatching(/^pm_/) });
  });

  it('rejects webhooks with a bad signature and ignores unknown events', () => {
    const payload = JSON.stringify({
      id: 'evt_1',
      object: 'event',
      type: 'charge.refunded',
      data: { object: {} },
    });
    expect(() => provider.parseWebhook(Buffer.from(payload), 't=1,v1=bad')).toThrow(ValidationError);
    const header = StripePaymentProvider.signatureHeader(payload, SECRET);
    expect(provider.parseWebhook(Buffer.from(payload), header)).toEqual({
      id: 'evt_1',
      type: 'ignored',
      eventType: 'charge.refunded',
    });
  });

  it('sends no card data anywhere: the server only ever sees intents and outcomes', () => {
    const bodies = JSON.stringify([...fake.state.objects.values()]);
    expect(bodies).not.toMatch(/4242|cvc|exp_month/);
  });
});
