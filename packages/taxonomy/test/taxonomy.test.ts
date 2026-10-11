import { describe, expect, it } from 'vitest';
import { ATTRIBUTES, attribute, CATEGORIES, normalizeValue } from '../src';

describe('taxonomy', () => {
  it('has about 150 attributes across every category', () => {
    expect(ATTRIBUTES.length).toBeGreaterThanOrEqual(140);
    expect(ATTRIBUTES.length).toBeLessThanOrEqual(180);
    for (const category of CATEGORIES) {
      expect(
        ATTRIBUTES.some((a) => a.category === category.code),
        category.code,
      ).toBe(true);
    }
  });

  it('uses unique snake_case codes', () => {
    const codes = ATTRIBUTES.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('normalizes values per type', () => {
    expect(normalizeValue(attribute('free_wifi')!, 'yes')).toBe(true);
    expect(normalizeValue(attribute('parking')!, 'paid')).toBe('paid');
    expect(normalizeValue(attribute('parking')!, 'sometimes')).toBeNull();
    expect(normalizeValue(attribute('room_size_sqm')!, '26')).toBe(26);
  });
});
