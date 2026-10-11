import { z } from 'zod';
import { LocalDate } from '../dates';
import { DisplayMoney } from '../money';

export const PaymentModeSchema = z
  .enum(['prepaid', 'pay_at_hotel'])
  .describe(
    'prepaid: guest pays the full amount at booking. pay_at_hotel: card guarantees the booking, guest pays at the hotel.',
  );

export const OfferDto = z.object({
  offerId: z.uuid().describe('Pass this to create_hold. Valid until expiresAt.'),
  hotelId: z.uuid(),
  roomType: z.object({ id: z.uuid(), name: z.string(), maxOccupancy: z.number().int().nullable() }),
  ratePlan: z.object({
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    includes: z.array(z.string()).describe('Services included in the price, e.g. Breakfast'),
  }),
  checkIn: LocalDate,
  checkOut: LocalDate,
  nights: z.number().int(),
  adults: z.number().int(),
  childrenAges: z.array(z.number().int()),
  paymentMode: PaymentModeSchema,
  total: DisplayMoney.describe('All-in price for the whole stay: accommodation, taxes and mandatory fees'),
  dueNow: DisplayMoney.describe('Charged when the guest completes checkout'),
  dueAtHotel: DisplayMoney.describe('Paid by the guest at the hotel'),
  priceBreakdown: z.object({
    accommodation: DisplayMoney,
    includedTaxes: DisplayMoney.describe('VAT already contained in accommodation'),
    extras: z
      .array(z.object({ label: z.string(), amount: DisplayMoney }))
      .describe('City tax and mandatory fees'),
    nightly: z.array(z.object({ date: LocalDate, amount: DisplayMoney })),
  }),
  cancellationPolicy: z.object({
    summary: z.string(),
    freeCancellationUntil: z.iso.datetime().nullable(),
    feeAfterDeadline: DisplayMoney,
  }),
  availableRooms: z.number().int(),
  expiresAt: z.iso.datetime(),
});
export type OfferDto = z.infer<typeof OfferDto>;

export const OfferQueryInput = z.object({
  checkIn: LocalDate,
  checkOut: LocalDate,
  adults: z.coerce.number().int().min(1).max(10).default(2),
  childrenAges: z
    .union([z.array(z.coerce.number().int().min(0).max(17)), z.string()])
    .optional()
    .transform((v) => (typeof v === 'string' ? v.split(',').filter(Boolean).map(Number) : (v ?? [])))
    .pipe(z.array(z.number().int().min(0).max(17)).max(6))
    .describe('Ages of children, e.g. [4, 9] (or "4,9" in a query string)'),
});
