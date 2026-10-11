import { z } from 'zod';
import { LocalDate } from '../dates';
import { CurrencyCode } from '../money';
import { PaymentModeSchema } from './offers';

export const BookingStatusSchema = z.enum([
  'pending_payment',
  'reserving',
  'confirmed',
  'failed',
  'cancelled',
]);
export const FeeStatusSchema = z.enum(['collected', 'pending', 'invoiced', 'void']);

/** Who sent the booking: a partner (API key), a self-identified agent app, or anonymous. */
export const AgentLabelDto = z.object({
  name: z.string(),
  partner: z.boolean(),
  channel: z.enum(['mcp', 'rest']),
});

export const BookingListItemDto = z.object({
  id: z.uuid(),
  reference: z.string(),
  propertyId: z.uuid(),
  propertyName: z.string(),
  status: BookingStatusSchema,
  statusReason: z.string().nullable(),
  paymentMode: PaymentModeSchema,
  currency: CurrencyCode,
  totalAmount: z.number().int(),
  feeBps: z.number().int(),
  feeAmount: z.number().int(),
  feeStatus: FeeStatusSchema.nullable(),
  arrival: LocalDate,
  departure: LocalDate,
  nights: z.number().int(),
  adults: z.number().int(),
  children: z.number().int(),
  roomTypeName: z.string(),
  ratePlanName: z.string(),
  /** Null once the guest's data has been erased after the retention period. */
  guestName: z.string().nullable(),
  agent: AgentLabelDto,
  confirmationNumber: z.string().nullable(),
  pmsReservationId: z.string().nullable(),
  /** Deep link to the reservation in the PMS. */
  pmsUrl: z.url().nullable(),
  createdAt: z.iso.datetime(),
  confirmedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),
});

export const BookingListDto = z.object({
  bookings: z.array(BookingListItemDto),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export const BookingListQuery = z.object({
  propertyId: z.uuid().optional(),
  status: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return undefined;
      const parsed = z.array(BookingStatusSchema).safeParse(v.split(','));
      if (!parsed.success) {
        ctx.addIssue({ code: 'custom', message: 'Unknown booking status' });
        return z.NEVER;
      }
      return parsed.data;
    }),
  from: LocalDate.optional().describe('Booked on or after this date (UTC)'),
  to: LocalDate.optional().describe('Booked before this date (UTC)'),
  q: z.string().trim().min(2).max(60).optional().describe('Reference, confirmation number or guest surname'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export const BookingDetailDto = BookingListItemDto.extend({
  /** Contact details: only for roles that manage guest data, and null once erased. */
  guestEmail: z.string().nullable(),
  guestPhone: z.string().nullable(),
  specialRequests: z.string().nullable(),
  piiRedactedAt: z.iso.datetime().nullable(),
  dueNowAmount: z.number().int(),
  price: z.object({
    accommodation: z.number().int(),
    includedTaxes: z.number().int(),
    extras: z.array(z.object({ label: z.string(), amount: z.number().int() })),
    nightly: z.array(z.object({ date: LocalDate, amount: z.number().int() })),
  }),
  cancellation: z.object({
    name: z.string().nullable(),
    description: z.string().nullable(),
    freeUntil: z.string().nullable(),
  }),
  payment: z.object({
    status: z.string(),
    paymentIntentId: z.string().nullable(),
    setupIntentId: z.string().nullable(),
    /** The payment in the hotel's own Stripe Dashboard. */
    dashboardUrl: z.url().nullable(),
  }),
  fee: z
    .object({
      collection: z.enum(['application_fee', 'invoice']),
      status: FeeStatusSchema,
      amount: z.number().int(),
      invoiceNumber: z.string().nullable(),
    })
    .nullable(),
  timeline: z.array(z.object({ at: z.iso.datetime(), label: z.string() })),
});

export const FUNNEL_STAGES = [
  { key: 'searches', label: 'Appeared in searches' },
  { key: 'views', label: 'Hotel viewed' },
  { key: 'offers', label: 'Rooms and rates quoted' },
  { key: 'holds', label: 'Room held' },
  { key: 'checkouts', label: 'Checkout started' },
  { key: 'paid', label: 'Paid or card guaranteed' },
  { key: 'reservations', label: 'Reservation in PMS' },
] as const;

export const FunnelStageKey = z.enum(FUNNEL_STAGES.map((s) => s.key) as [string, ...string[]]);
export type FunnelStageKey = (typeof FUNNEL_STAGES)[number]['key'];

const StageCounts = z.object({
  searches: z.number().int(),
  views: z.number().int(),
  offers: z.number().int(),
  holds: z.number().int(),
  checkouts: z.number().int(),
  paid: z.number().int(),
  reservations: z.number().int(),
});
export type StageCounts = z.infer<typeof StageCounts>;

export const FunnelQuery = z.object({
  propertyId: z.uuid().optional(),
  days: z.coerce
    .number()
    .int()
    .refine((d) => [7, 30, 90].includes(d), 'days must be 7, 30 or 90')
    .default(30),
});

export const FunnelDto = z.object({
  from: LocalDate,
  to: LocalDate,
  timeZone: z.string(),
  totals: StageCounts,
  stages: z.array(
    z.object({
      key: FunnelStageKey,
      label: z.string(),
      count: z.number().int(),
      /** Percent of the previous stage that reached this one (null for the first or an empty previous). */
      conversion: z.number().int().nullable(),
    }),
  ),
  byAgent: z.array(AgentLabelDto.extend({ counts: StageCounts })),
  daily: z.array(StageCounts.extend({ date: LocalDate })),
});

export const FeeInvoiceDto = z.object({
  id: z.uuid(),
  period: z.string(),
  currency: CurrencyCode,
  amount: z.number().int(),
  feeCount: z.number().int(),
  status: z.enum(['draft', 'open', 'paid', 'void', 'uncollectible']),
  number: z.string().nullable(),
  hostedUrl: z.url().nullable(),
  pdfUrl: z.url().nullable(),
  dueAt: z.iso.datetime().nullable(),
  issuedAt: z.iso.datetime().nullable(),
  paidAt: z.iso.datetime().nullable(),
});

export const FeesDto = z.object({
  properties: z.array(z.object({ id: z.uuid(), name: z.string(), feeBps: z.number().int() })),
  months: z.array(
    z.object({
      period: z.string(),
      currency: CurrencyCode,
      bookings: z.number().int(),
      bookingValue: z.number().int(),
      collected: z.number().int().describe('Taken as Stripe application fees on prepaid bookings'),
      pending: z.number().int().describe('Pay-at-hotel fees to be invoiced after the stay'),
      invoiced: z.number().int(),
      void: z.number().int(),
    }),
  ),
  invoices: z.array(FeeInvoiceDto),
});

export type BookingListItemDto = z.infer<typeof BookingListItemDto>;
export type BookingListDto = z.infer<typeof BookingListDto>;
export type BookingDetailDto = z.infer<typeof BookingDetailDto>;
export type FunnelDto = z.infer<typeof FunnelDto>;
export type FeeInvoiceDto = z.infer<typeof FeeInvoiceDto>;
export type FeesDto = z.infer<typeof FeesDto>;
export type AgentLabelDto = z.infer<typeof AgentLabelDto>;
