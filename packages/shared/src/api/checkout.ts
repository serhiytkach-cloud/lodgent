import { z } from 'zod';
import { LocalDate } from '../dates';
import { DisplayMoney } from '../money';
import { PaymentModeSchema } from './offers';

/** Guest details collected on the hosted checkout page (the only place guest PII enters). */
export const CheckoutGuestInput = z.object({
  firstName: z.string().trim().min(1, 'Enter your first name').max(80),
  lastName: z.string().trim().min(1, 'Enter your last name').max(80),
  email: z.email('Enter a valid email address').max(200),
  phone: z
    .string()
    .trim()
    .max(40)
    .regex(/^[+0-9 ()./-]*$/, 'Use digits, spaces and + ( ) - only')
    .nullable()
    .default(null)
    .transform((v) => (v ? v : null)),
  specialRequests: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .default(null)
    .transform((v) => (v ? v : null)),
  acceptTerms: z.literal(true, { error: 'Please accept the booking terms' }),
});
export type CheckoutGuestInput = z.infer<typeof CheckoutGuestInput>;

export const CheckoutStatus = z.enum([
  'open',
  'awaiting_payment',
  'processing',
  'confirmed',
  'failed',
  'expired',
  'cancelled',
]);
export type CheckoutStatus = z.infer<typeof CheckoutStatus>;

export const CheckoutDto = z.object({
  status: CheckoutStatus,
  statusMessage: z.string().nullable(),
  expiresAt: z.iso.datetime(),
  hotel: z.object({
    name: z.string(),
    address: z.string().nullable(),
    logoUrl: z.string().nullable(),
    brandColor: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    checkInTime: z.string().nullable(),
    checkOutTime: z.string().nullable(),
    profileUrl: z.string(),
  }),
  stay: z.object({
    checkIn: LocalDate,
    checkOut: LocalDate,
    nights: z.number().int(),
    adults: z.number().int(),
    childrenAges: z.array(z.number().int()),
    roomType: z.string(),
    ratePlan: z.string(),
    includes: z.array(z.string()),
  }),
  price: z.object({
    total: DisplayMoney,
    dueNow: DisplayMoney,
    dueAtHotel: DisplayMoney,
    accommodation: DisplayMoney,
    includedTaxes: DisplayMoney,
    extras: z.array(z.object({ label: z.string(), amount: DisplayMoney })),
  }),
  paymentMode: PaymentModeSchema,
  cancellation: z.string(),
  policies: z.array(z.object({ title: z.string(), description: z.string().nullable() })),
  guest: z
    .object({ firstName: z.string(), lastName: z.string(), email: z.string(), phone: z.string().nullable() })
    .nullable(),
  booking: z.object({ reference: z.string(), confirmationNumber: z.string().nullable() }).nullable(),
  payment: z
    .object({
      provider: z.literal('stripe'),
      publishableKey: z.string(),
      accountId: z.string(),
      kind: z.enum(['payment', 'setup']),
      clientSecret: z.string(),
      /** Local development only: the fake Stripe server's URL for the simulated payment panel. */
      simulatorUrl: z.string().nullable(),
    })
    .nullable(),
});
export type CheckoutDto = z.infer<typeof CheckoutDto>;

export const PaymentAccountDto = z.object({
  connected: z.boolean(),
  status: z.enum(['not_connected', 'onboarding', 'active', 'restricted']),
  accountId: z.string().nullable(),
  chargesEnabled: z.boolean(),
  payoutsEnabled: z.boolean(),
  detailsSubmitted: z.boolean(),
  requirementsDue: z.array(z.string()),
  defaultFeeBps: z.number().int(),
});
export type PaymentAccountDto = z.infer<typeof PaymentAccountDto>;
