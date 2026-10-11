import { z } from 'zod';
import { LocalDate } from '../dates';
import { CurrencyCode, Money } from '../money';
import { BookingStatusSchema } from './bookings';
import { PaymentModeSchema } from './offers';

/**
 * A guest's email address as typed by hotel staff: trimmed and lower-cased (bookings store it
 * lower-cased), then validated. Sent in request bodies only, never in URLs, so it stays out of logs.
 */
export const GuestEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email('Enter a valid email address'))
  .describe("The guest's email address (matched case-insensitively)");

export const GuestDataExportInput = z.object({ email: GuestEmail });
export type GuestDataExportInput = z.infer<typeof GuestDataExportInput>;

export const GuestDataEraseInput = z.object({
  email: GuestEmail,
  /** Why the data is erased (e.g. "guest request by email"). Contact details in it are masked. */
  reason: z.string().trim().max(200).optional(),
});
export type GuestDataEraseInput = z.infer<typeof GuestDataEraseInput>;

/**
 * Pseudonymous reference to a guest within one organization: a keyed hash of the email, so audit
 * entries and responses can be correlated without storing the address itself.
 */
export const GuestSubjectRef = z
  .string()
  .regex(/^g_[0-9a-f]{32}$/)
  .describe('Pseudonymous guest reference (keyed hash of the email); never the email itself');

export const GuestBookingExportDto = z.object({
  id: z.uuid(),
  reference: z.string(),
  status: BookingStatusSchema,
  property: z.object({ id: z.uuid(), name: z.string() }),
  stay: z.object({
    arrival: LocalDate,
    departure: LocalDate,
    nights: z.number().int(),
    adults: z.number().int(),
    childrenAges: z.array(z.number().int()),
    roomType: z.string(),
    ratePlan: z.string(),
    timeZone: z.string(),
  }),
  price: z.object({
    currency: CurrencyCode,
    total: Money,
    dueAtBooking: Money,
    paymentMode: PaymentModeSchema,
    paymentStatus: z.string(),
  }),
  guest: z.object({
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    specialRequests: z.string().nullable(),
  }),
  /** The hotel's confirmation number in its PMS, where the reservation itself lives. */
  confirmationNumber: z.string().nullable(),
  bookedVia: z.enum(['mcp', 'rest']).describe('How the AI agent reached us'),
  termsAcceptedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  confirmedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
});
export type GuestBookingExportDto = z.infer<typeof GuestBookingExportDto>;

/** Everything held about one guest in one organization (data subject access request). */
export const GuestDataExportDto = z.object({
  generatedAt: z.iso.datetime(),
  organization: z.object({ id: z.uuid(), name: z.string() }),
  subject: z.object({ email: z.string(), ref: GuestSubjectRef }),
  bookings: z.array(GuestBookingExportDto),
  /** Where else the guest's data lives and how long we keep ours. */
  notes: z.array(z.string()),
});
export type GuestDataExportDto = z.infer<typeof GuestDataExportDto>;

export const GuestDataEraseDto = z.object({
  subject: z.object({ ref: GuestSubjectRef }),
  /** Bookings that matched the email (already-erased bookings no longer match). */
  matched: z.number().int(),
  erased: z.number().int(),
  /** Checkouts still running; erase again once they finish (within about an hour). */
  deferred: z.number().int(),
  /** Unsent confirmation emails to this guest that were dropped. */
  pendingEmailsDropped: z.number().int(),
  bookings: z.array(
    z.object({
      id: z.uuid(),
      reference: z.string(),
      propertyName: z.string(),
      arrival: LocalDate,
      departure: LocalDate,
      status: BookingStatusSchema,
      result: z.enum(['erased', 'deferred']),
    }),
  ),
  /** What the hotel still has to do elsewhere (PMS, Stripe), and deferred bookings. */
  warnings: z.array(z.string()),
});
export type GuestDataEraseDto = z.infer<typeof GuestDataEraseDto>;
