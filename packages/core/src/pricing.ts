import { formatMoney, type Money } from '@lodgent/shared';

export interface CancellationTerms {
  name: string | null;
  freeUntil: Date | null;
  fee: Money;
  /** The room price the fee is measured against (accommodation, excluding city tax and fees). */
  stayPrice: Money;
}

/** Plain-language cancellation summary for agents and the checkout page. */
export function describeCancellation(terms: CancellationTerms, timeZone: string, now: Date): string {
  const feeIsTotal = terms.fee.amount >= terms.stayPrice.amount;
  if (!terms.freeUntil || terms.freeUntil <= now) {
    if (terms.fee.amount === 0) return 'Free cancellation at any time.';
    return feeIsTotal
      ? 'Non-refundable: the full amount is charged if you cancel or don’t show up.'
      : `Cancelling now costs ${formatMoney(terms.fee)}.`;
  }
  const deadline = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(terms.freeUntil);
  if (terms.fee.amount === 0) return 'Free cancellation at any time.';
  return `Free cancellation until ${deadline} (hotel local time). After that, ${
    feeIsTotal ? 'the full amount' : formatMoney(terms.fee)
  } is charged.`;
}

/** Fit of an offer total to a budget, 0..1 (1 = at or under budget, falling off to 0 at 50% over). */
export function priceFit(total: number, budget: number | null): number {
  if (budget === null || budget <= 0) return 1;
  if (total <= budget) return 1;
  const over = (total - budget) / budget;
  return Math.max(0, 1 - over * 2);
}
