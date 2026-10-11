import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDateTime(iso: string, locale = 'en-GB'): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

export function formatDate(isoOrLocal: string, locale = 'en-GB'): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(isoOrLocal)
    ? new Date(`${isoOrLocal}T12:00:00Z`)
    : new Date(isoOrLocal);
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
}
