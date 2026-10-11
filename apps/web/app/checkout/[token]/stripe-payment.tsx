'use client';

import type { CheckoutDto } from '@lodgent/shared';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { type FormEvent, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/misc';

type Payment = NonNullable<CheckoutDto['payment']>;

const stripes = new Map<string, Promise<Stripe | null>>();

/** One Stripe.js instance per connected account (direct charges run on the hotel's account). */
function stripeFor(publishableKey: string, accountId: string): Promise<Stripe | null> {
  const key = `${publishableKey}:${accountId}`;
  let promise = stripes.get(key);
  if (!promise) {
    promise = loadStripe(publishableKey, { stripeAccount: accountId });
    stripes.set(key, promise);
  }
  return promise;
}

/**
 * Stripe's Payment Element: card fields are Stripe-hosted iframes, so card data goes from the
 * guest's browser straight to Stripe and never touches our servers.
 */
export function StripePayment({
  payment,
  label,
  brandColor,
  returnUrl,
  onSucceeded,
}: {
  payment: Payment;
  label: string;
  brandColor: string | null;
  returnUrl: string;
  onSucceeded: () => void;
}) {
  const stripePromise = useMemo(() => stripeFor(payment.publishableKey, payment.accountId), [payment]);
  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret: payment.clientSecret,
        appearance: {
          theme: 'stripe',
          variables: { colorPrimary: brandColor ?? '#1d4ed8', borderRadius: '8px', fontSizeBase: '16px' },
        },
      }}
    >
      <PaymentForm kind={payment.kind} label={label} returnUrl={returnUrl} onSucceeded={onSucceeded} />
    </Elements>
  );
}

function PaymentForm({
  kind,
  label,
  returnUrl,
  onSucceeded,
}: {
  kind: Payment['kind'];
  label: string;
  returnUrl: string;
  onSucceeded: () => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!stripe || !elements) return;
    setPending(true);
    setError(null);
    const result =
      kind === 'payment'
        ? await stripe.confirmPayment({
            elements,
            redirect: 'if_required',
            confirmParams: { return_url: returnUrl },
          })
        : await stripe.confirmSetup({
            elements,
            redirect: 'if_required',
            confirmParams: { return_url: returnUrl },
          });
    if (result.error) {
      setError(result.error.message ?? 'The payment could not be completed.');
      setPending(false);
      return;
    }
    onSucceeded();
  }

  return (
    <form onSubmit={submit} className="grid gap-4">
      <PaymentElement options={{ layout: 'tabs' }} />
      {error ? <Alert variant="error">{error}</Alert> : null}
      <Button type="submit" size="lg" disabled={!stripe || pending} className="w-full">
        {pending ? 'Processing…' : label}
      </Button>
    </form>
  );
}

/**
 * Local development only: stands in for Stripe.js when the API talks to the fake Stripe server.
 * It confirms the intent with an outcome, not card data.
 */
export function SimulatedPayment({
  payment,
  label,
  onSucceeded,
}: {
  payment: Payment;
  label: string;
  onSucceeded: () => void;
}) {
  const [pending, setPending] = useState<'succeed' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function confirm(outcome: 'succeed' | 'decline') {
    setPending(outcome);
    setError(null);
    try {
      const res = await fetch(`${payment.simulatorUrl}/_fake/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_secret: payment.clientSecret, outcome }),
      });
      const json = (await res.json()) as { error?: { message?: string } };
      if (json.error) {
        setError(json.error.message ?? 'The payment was declined.');
        return;
      }
      onSucceeded();
    } catch {
      setError('Could not reach the test payment server.');
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="grid gap-3">
      <div className="rounded-lg border border-dashed border-warning/60 bg-warning/10 p-4 text-sm">
        <p className="font-medium">Test mode: no real card</p>
        <p className="mt-1 text-muted-foreground">
          Locally, payments go to a simulated Stripe. With real Stripe keys, Stripe’s secure card form appears
          here.
        </p>
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <Button size="lg" className="w-full" disabled={pending !== null} onClick={() => confirm('succeed')}>
        {pending === 'succeed' ? 'Processing…' : `${label} (test card)`}
      </Button>
      <Button variant="ghost" size="sm" disabled={pending !== null} onClick={() => confirm('decline')}>
        Simulate a declined card
      </Button>
    </div>
  );
}
