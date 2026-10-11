import { z } from 'zod';

/**
 * A calendar date in the property's own time zone, formatted YYYY-MM-DD.
 * Stay dates (check-in/check-out) are always property-local; never convert them to instants.
 */
export const LocalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date formatted YYYY-MM-DD')
  .refine(isValidLocalDate, 'Not a real calendar date')
  .describe('Property-local calendar date, YYYY-MM-DD');
export type LocalDate = z.infer<typeof LocalDate>;

/** IANA time zone such as Europe/Lisbon. */
export const TimeZone = z
  .string()
  .refine(isValidTimeZone, 'Unknown IANA time zone')
  .describe('IANA time zone, e.g. Europe/Lisbon');

/** A wall-clock time such as 15:00. */
export const LocalTime = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM')
  .describe('Property-local time, HH:MM');

export function isValidLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function toUtcMidnight(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

const DAY_MS = 86_400_000;

/** Number of nights between check-in and check-out (calendar arithmetic, DST-safe). */
export function nightsBetween(checkIn: string, checkOut: string): number {
  return Math.round((toUtcMidnight(checkOut) - toUtcMidnight(checkIn)) / DAY_MS);
}

export function addDays(date: string, days: number): string {
  return new Date(toUtcMidnight(date) + days * DAY_MS).toISOString().slice(0, 10);
}

export function compareLocalDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Today's date at the property, given an instant. */
export function localDateAt(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Converts a property-local wall-clock date+time into a UTC instant.
 * Uses the zone's offset at that wall-clock time (handles DST).
 */
export function zonedDateTimeToInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const asUtc = Date.UTC(y, m - 1, d, hh, mm);
  const offset = timeZoneOffsetMs(new Date(asUtc), timeZone);
  const candidate = asUtc - offset;
  // Re-evaluate at the candidate instant in case we crossed a DST boundary.
  const offset2 = timeZoneOffsetMs(new Date(candidate), timeZone);
  return new Date(asUtc - offset2);
}

function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Validated stay: check-in strictly before check-out, bounded length. */
export const StayDates = z
  .object({
    checkIn: LocalDate.describe('Check-in date (property-local), YYYY-MM-DD'),
    checkOut: LocalDate.describe('Check-out date (property-local), YYYY-MM-DD'),
  })
  .refine((v) => nightsBetween(v.checkIn, v.checkOut) >= 1, {
    message: 'checkOut must be after checkIn',
    path: ['checkOut'],
  })
  .refine((v) => nightsBetween(v.checkIn, v.checkOut) <= 30, {
    message: 'Stays are limited to 30 nights',
    path: ['checkOut'],
  });
