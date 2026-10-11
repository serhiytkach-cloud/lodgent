import { describe, expect, it } from 'vitest';
import { bookingFee, DEFAULT_FEE_BPS, describeCancellation, priceFit } from '../src';

describe('bookingFee', () => {
  it('charges 2% by default', () => {
    expect(bookingFee({ amount: 41250, currency: 'EUR' }, DEFAULT_FEE_BPS)).toEqual({
      amount: 825,
      currency: 'EUR',
    });
  });

  it('supports per-hotel rates and rejects absurd ones', () => {
    expect(bookingFee({ amount: 10000, currency: 'USD' }, 150).amount).toBe(150);
    expect(() => bookingFee({ amount: 10000, currency: 'USD' }, 5000)).toThrow();
  });
});

describe('describeCancellation', () => {
  const now = new Date('2026-10-01T10:00:00Z');
  const stayPrice = { amount: 30000, currency: 'EUR' };

  it('describes free cancellation windows in hotel time', () => {
    const text = describeCancellation(
      {
        name: null,
        freeUntil: new Date('2026-10-20T17:00:00Z'),
        fee: { amount: 15000, currency: 'EUR' },
        stayPrice,
      },
      'Europe/Lisbon',
      now,
    );
    expect(text).toBe(
      'Free cancellation until 20 Oct 2026, 18:00 (hotel local time). After that, €150.00 is charged.',
    );
  });

  it('calls a full-price fee non-refundable', () => {
    const text = describeCancellation({ name: null, freeUntil: now, fee: stayPrice, stayPrice }, 'UTC', now);
    expect(text).toMatch(/^Non-refundable/);
  });

  it('scores price fit against a budget', () => {
    expect(priceFit(9000, 10000)).toBe(1);
    expect(priceFit(12500, 10000)).toBe(0.5);
    expect(priceFit(20000, 10000)).toBe(0);
    expect(priceFit(20000, null)).toBe(1);
  });
});
