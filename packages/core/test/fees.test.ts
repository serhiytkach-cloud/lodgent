import { describe, expect, it } from 'vitest';
import { bookingFee, DEFAULT_FEE_BPS } from '../src';

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
