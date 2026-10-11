'use server';

import type { CheckoutDto } from '@lodgent/shared';
import { ApiError, api } from '@/lib/api';

export type CheckoutResult =
  | { ok: true; checkout: CheckoutDto }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

async function call(path: string, body?: unknown): Promise<CheckoutResult> {
  try {
    const checkout = await api<CheckoutDto>(path, {
      method: body === undefined && !path.endsWith('/complete') ? 'GET' : 'POST',
      body,
      token: null,
      redirectOnUnauthorized: false,
    });
    return { ok: true, checkout };
  } catch (error) {
    if (error instanceof ApiError) {
      return {
        ok: false,
        error: error.message,
        fieldErrors: error.status === 400 ? error.fieldErrors() : undefined,
      };
    }
    throw error;
  }
}

/** Guest details only: card details go from the browser straight to Stripe, never through here. */
export async function startCheckout(token: string, formData: FormData): Promise<CheckoutResult> {
  const text = (name: string) => {
    const v = formData.get(name);
    return typeof v === 'string' ? v : '';
  };
  return call(`/v1/checkout/${encodeURIComponent(token)}/guest`, {
    firstName: text('firstName'),
    lastName: text('lastName'),
    email: text('email'),
    phone: text('phone') || null,
    specialRequests: text('specialRequests') || null,
    acceptTerms: formData.get('acceptTerms') === 'on',
  });
}

export async function completeCheckout(token: string): Promise<CheckoutResult> {
  return call(`/v1/checkout/${encodeURIComponent(token)}/complete`);
}

export async function refreshCheckout(token: string): Promise<CheckoutResult> {
  return call(`/v1/checkout/${encodeURIComponent(token)}`);
}
