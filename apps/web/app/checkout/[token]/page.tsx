import type { CheckoutDto } from '@lodgent/shared';
import { BRAND } from '@lodgent/shared';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError, api } from '@/lib/api';
import { CheckoutApp } from './checkout-app';

export const metadata: Metadata = {
  title: `Complete your booking · ${BRAND.name}`,
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function CheckoutPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ complete?: string }>;
}) {
  const { token } = await params;
  const { complete } = await searchParams;
  let checkout: CheckoutDto;
  try {
    checkout = await api<CheckoutDto>(`/v1/checkout/${encodeURIComponent(token)}`, { token: null });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  return <CheckoutApp token={token} initial={checkout} completeOnLoad={complete === '1'} />;
}
