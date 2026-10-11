/**
 * Monthly fee invoicing periods. Pay-at-hotel fees are invoiced once the stay has ended: the run on
 * the first of a month bills every uninvoiced fee for stays that departed before that day, under the
 * previous month's period.
 */

/** Smallest invoice we issue (minor units); smaller balances roll over to the next month. */
export const MIN_INVOICE_AMOUNT = 100;
export const INVOICE_DAYS_UNTIL_DUE = 14;

/** The period ending before `now` (UTC): `{ period: '2026-09', departedBefore: '2026-10-01' }`. */
export function previousBillingPeriod(now: Date): { period: string; departedBefore: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based: the current month; the period is the month before
  const prev = new Date(Date.UTC(y, m - 1, 1));
  return {
    period: `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`,
    departedBefore: `${y}-${String(m + 1).padStart(2, '0')}-01`,
  };
}

/** `2026-09` → `September 2026`. */
export function periodLabel(period: string, locale = 'en'): string {
  const [y, m] = period.split('-').map(Number);
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y!, m! - 1, 1)),
  );
}
