import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { containsCardNumber, luhnValid } from '../src/http/card-guard';

describe('card data guard', () => {
  it.each([
    '4242424242424242',
    '4242 4242 4242 4242',
    '5555-5555-5555-4444',
    '378282246310005',
    'my card is 4000 0566 5566 5556 exp 12/30',
    '{"preferences":"pay with 6011111111111117"}',
  ])('detects %s', (text) => {
    expect(containsCardNumber(text)).toBe(true);
  });

  it.each([
    '4242424242424241', // fails Luhn
    '+351 912 345 678',
    '+1 843 555 0100',
    '2026-11-10T05:10:33.429Z',
    'checkIn 2026-11-10 checkOut 2026-11-12',
    'order 1234567890123',
    'LG-7K3P9Q2M',
  ])('ignores %s', (text) => {
    expect(containsCardNumber(text)).toBe(false);
  });

  it('never flags UUIDs', () => {
    for (let i = 0; i < 20_000; i++)
      expect(containsCardNumber(JSON.stringify({ offerId: randomUUID() }))).toBe(false);
  });

  it('implements Luhn', () => {
    expect(luhnValid('79927398713')).toBe(true);
    expect(luhnValid('79927398710')).toBe(false);
  });
});
