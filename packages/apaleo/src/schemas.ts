import { z } from 'zod';

/**
 * Zod schemas for the subset of the Apaleo API we use. Field names and enums follow Apaleo's
 * official generated TypeScript models (@apaleo/angular-api-proxy-* 19.0.29); see
 * docs/adr/0006-apaleo-integration.md. Objects are non-strict so new Apaleo fields don't break us.
 */

export const MonetaryValue = z.object({ amount: z.number(), currency: z.string() });
export const AmountModel = z.object({
  grossAmount: z.number(),
  netAmount: z.number().optional(),
  currency: z.string(),
});

export const GuaranteeEnum = z.enum(['PM6Hold', 'CreditCard', 'Prepayment', 'Company']);

export const TokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

export const AccountModel = z.object({ code: z.string(), name: z.string().optional() });

const Address = z.object({
  addressLine1: z.string().nullish(),
  addressLine2: z.string().nullish(),
  postalCode: z.string().nullish(),
  city: z.string().nullish(),
  regionCode: z.string().nullish(),
  countryCode: z.string().nullish(),
});

export const PropertyItem = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  location: Address.nullish(),
  timeZone: z.string(),
  currencyCode: z.string(),
  status: z.enum(['Test', 'Live']).or(z.string()),
  isArchived: z.boolean().optional(),
});
export const PropertyList = z.object({
  properties: z.array(PropertyItem).default([]),
  count: z.number().optional(),
});

export const UnitGroupItem = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  memberCount: z.number().default(0),
  maxPersons: z.number().nullish(),
  type: z.string(),
  property: z.object({ id: z.string() }),
});
export const UnitGroupList = z.object({
  unitGroups: z.array(UnitGroupItem).default([]),
  count: z.number().optional(),
});

export const RatePlanItem = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  minGuaranteeType: GuaranteeEnum,
  property: z.object({ id: z.string() }),
  unitGroup: z.object({ id: z.string(), name: z.string().nullish() }),
  cancellationPolicy: z
    .object({
      id: z.string(),
      code: z.string().nullish(),
      name: z.string().nullish(),
      description: z.string().nullish(),
    })
    .nullish(),
  channelCodes: z.array(z.string()).default([]),
  isBookable: z.boolean().default(true),
  isArchived: z.boolean().optional(),
  includedServices: z
    .array(
      z.object({
        service: z.object({
          id: z.string(),
          code: z.string().nullish(),
          name: z.string().nullish(),
          description: z.string().nullish(),
        }),
      }),
    )
    .nullish(),
});
export const RatePlanList = z.object({
  ratePlans: z.array(RatePlanItem).default([]),
  count: z.number().optional(),
});

export const Offer = z.object({
  arrival: z.string(),
  departure: z.string(),
  unitGroup: z.object({
    id: z.string(),
    code: z.string().nullish(),
    name: z.string(),
    description: z.string().nullish(),
    maxPersons: z.number().nullish(),
  }),
  ratePlan: z.object({
    id: z.string(),
    code: z.string().nullish(),
    name: z.string().nullish(),
    description: z.string().nullish(),
  }),
  minGuaranteeType: GuaranteeEnum,
  availableUnits: z.number(),
  totalGrossAmount: MonetaryValue,
  prePaymentAmount: MonetaryValue.nullish(),
  cancellationFee: z.object({
    code: z.string().nullish(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    dueDateTime: z.string().nullish(),
    fee: MonetaryValue,
  }),
  noShowFee: z.object({ fee: MonetaryValue }).nullish(),
  timeSlices: z
    .array(z.object({ from: z.string(), to: z.string(), totalGrossAmount: MonetaryValue }))
    .default([]),
  services: z
    .array(
      z.object({
        service: z.object({ name: z.string().nullish(), code: z.string().nullish() }),
        totalAmount: AmountModel,
      }),
    )
    .nullish(),
  fees: z
    .array(z.object({ code: z.string().nullish(), name: z.string(), totalAmount: AmountModel }))
    .nullish(),
  cityTaxes: z
    .array(z.object({ code: z.string().nullish(), name: z.string(), totalGrossAmount: MonetaryValue }))
    .nullish(),
  taxDetails: z
    .array(z.object({ vatType: z.string(), vatPercent: z.number(), tax: MonetaryValue }))
    .default([]),
  validationMessages: z.array(z.object({ code: z.string(), message: z.string() })).nullish(),
});
export type ApaleoOffer = z.infer<typeof Offer>;
export const StayOffers = z.object({
  property: z.object({ id: z.string() }).nullish(),
  offers: z.array(Offer).default([]),
});

export const BookingCreated = z.object({
  id: z.string(),
  reservationIds: z.array(z.object({ id: z.string() })),
});

export const ReservationStatus = z.enum(['Confirmed', 'InHouse', 'CheckedOut', 'Canceled', 'NoShow']);
export const Reservation = z.object({ id: z.string(), bookingId: z.string(), status: ReservationStatus });

export const FolioList = z.object({
  folios: z
    .array(z.object({ id: z.string(), isMainFolio: z.boolean().optional(), type: z.string().optional() }))
    .default([]),
});

export const SubscriptionCreated = z.object({ id: z.string() });

/** Body Apaleo POSTs to our webhook endpoint. */
export const WebhookEvent = z.object({
  topic: z.string(),
  type: z.string(),
  id: z.string().optional(),
  accountId: z.string().optional(),
  propertyId: z.string().optional(),
  timestamp: z.number().optional(),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;
