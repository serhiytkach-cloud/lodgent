import { z } from 'zod';

/** ISO 4217 currency code, upper case. */
export const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 currency code such as EUR')
  .describe('ISO 4217 currency code, e.g. EUR');
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/**
 * Money is always an integer amount in the currency's minor unit (cents for EUR/USD,
 * yen for JPY) plus the currency code. Never use floats for money.
 */
export const Money = z
  .object({
    amount: z.number().int().describe('Amount in minor units (e.g. cents). 41250 EUR = €412.50'),
    currency: CurrencyCode,
  })
  .describe('Money in integer minor units plus currency');
export type Money = z.infer<typeof Money>;

/** Money with a display string, used in agent-facing responses so LLMs don't have to convert units. */
export const DisplayMoney = Money.extend({
  formatted: z.string().describe('Human-readable amount, e.g. "€412.50"'),
});
export type DisplayMoney = z.infer<typeof DisplayMoney>;

const exponentCache = new Map<string, number>();

/** Number of decimal places of the currency's minor unit (EUR 2, JPY 0, BHD 3). */
export function minorUnitExponent(currency: string): number {
  const cached = exponentCache.get(currency);
  if (cached !== undefined) return cached;
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits;
  const exponent = digits ?? 2;
  exponentCache.set(currency, exponent);
  return exponent;
}

export function money(amount: number, currency: string): Money {
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`Money amount must be a safe integer in minor units, got ${amount}`);
  }
  return { amount, currency };
}

/** Converts a decimal major-unit amount (as provided by PMS APIs) into integer minor units. */
export function fromMajor(major: number, currency: string): Money {
  const exponent = minorUnitExponent(currency);
  // Round via string to avoid binary float artefacts such as 0.1 + 0.2.
  const scaled = Math.round(Number(`${major}e${exponent}`));
  return money(scaled, currency);
}

export function toMajor(value: Money): number {
  return Number(`${value.amount}e-${minorUnitExponent(value.currency)}`);
}

export function formatMoney(value: Money, locale = 'en'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: value.currency }).format(
    toMajor(value),
  );
}

export function toDisplayMoney(value: Money, locale = 'en'): DisplayMoney {
  return { ...value, formatted: formatMoney(value, locale) };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function sumMoney(values: readonly Money[], currency: string): Money {
  return values.reduce<Money>((acc, v) => addMoney(acc, v), money(0, currency));
}

export function zeroMoney(currency: string): Money {
  return money(0, currency);
}

/**
 * Applies a rate in basis points (1 bp = 0.01%) with round-half-up on the minor unit.
 * 200 bps of 41250 = 825.
 */
export function applyBasisPoints(value: Money, bps: number): Money {
  if (!Number.isInteger(bps) || bps < 0) throw new Error(`Invalid basis points: ${bps}`);
  const raw = (value.amount * bps) / 10_000;
  return money(Math.sign(raw) * Math.floor(Math.abs(raw) + 0.5), value.currency);
}
