import { describe, expect, it } from 'vitest';
import {
  addDays,
  applyBasisPoints,
  formatMoney,
  fromMajor,
  isValidLocalDate,
  LocalDate,
  localDateAt,
  minorUnitExponent,
  nightsBetween,
  StayDates,
  sumMoney,
  toMajor,
  zonedDateTimeToInstant,
} from '../src';

describe('money', () => {
  it('knows minor unit exponents', () => {
    expect(minorUnitExponent('EUR')).toBe(2);
    expect(minorUnitExponent('JPY')).toBe(0);
    expect(minorUnitExponent('BHD')).toBe(3);
  });

  it('converts major units without float artefacts', () => {
    expect(fromMajor(0.1 + 0.2, 'EUR')).toEqual({ amount: 30, currency: 'EUR' });
    expect(fromMajor(412.5, 'EUR').amount).toBe(41250);
    expect(fromMajor(12000, 'JPY').amount).toBe(12000);
    expect(toMajor({ amount: 41250, currency: 'EUR' })).toBe(412.5);
  });

  it('applies basis points with half-up rounding', () => {
    expect(applyBasisPoints({ amount: 41250, currency: 'EUR' }, 200).amount).toBe(825);
    expect(applyBasisPoints({ amount: 125, currency: 'EUR' }, 200).amount).toBe(3); // 2.5 -> 3
    expect(applyBasisPoints({ amount: 124, currency: 'EUR' }, 200).amount).toBe(2); // 2.48 -> 2
    expect(() => applyBasisPoints({ amount: 1, currency: 'EUR' }, -1)).toThrow();
  });

  it('refuses to mix currencies', () => {
    expect(() =>
      sumMoney(
        [
          { amount: 1, currency: 'EUR' },
          { amount: 1, currency: 'USD' },
        ],
        'EUR',
      ),
    ).toThrow(/Currency mismatch/);
  });

  it('formats', () => {
    expect(formatMoney({ amount: 41250, currency: 'EUR' })).toBe('€412.50');
  });
});

describe('dates', () => {
  it('validates calendar dates', () => {
    expect(isValidLocalDate('2026-02-29')).toBe(false);
    expect(isValidLocalDate('2028-02-29')).toBe(true);
    expect(LocalDate.safeParse('2026-13-01').success).toBe(false);
  });

  it('counts nights across DST changes', () => {
    expect(nightsBetween('2026-10-24', '2026-10-27')).toBe(3);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('validates stays', () => {
    expect(StayDates.safeParse({ checkIn: '2026-11-02', checkOut: '2026-11-02' }).success).toBe(false);
    expect(StayDates.safeParse({ checkIn: '2026-11-02', checkOut: '2026-11-05' }).success).toBe(true);
  });

  it('computes property-local dates and instants', () => {
    const instant = new Date('2026-10-10T23:30:00Z');
    expect(localDateAt(instant, 'Europe/Lisbon')).toBe('2026-10-11');
    expect(localDateAt(instant, 'America/New_York')).toBe('2026-10-10');
    // 15:00 in Lisbon in summer time (UTC+1)
    expect(zonedDateTimeToInstant('2026-07-01', '15:00', 'Europe/Lisbon').toISOString()).toBe(
      '2026-07-01T14:00:00.000Z',
    );
    // 15:00 in Lisbon in winter time (UTC+0)
    expect(zonedDateTimeToInstant('2026-12-01', '15:00', 'Europe/Lisbon').toISOString()).toBe(
      '2026-12-01T15:00:00.000Z',
    );
  });
});
