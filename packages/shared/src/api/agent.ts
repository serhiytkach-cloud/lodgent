import { z } from 'zod';
import { LocalDate } from '../dates';
import { CurrencyCode, DisplayMoney } from '../money';
import { OfferDto, PaymentModeSchema } from './offers';
import { HotelProfileDto } from './profile';

/**
 * The agent surface: the same schemas back the REST API (/v1/agent/*), the MCP tools and the
 * OpenAPI document, so the three never drift apart.
 */

const Phrase = z.string().trim().min(2).max(60);
const ChildrenAges = z
  .array(z.number().int().min(0).max(17))
  .max(6)
  .default([])
  .describe('Ages of children travelling, e.g. [4, 9]');

export const SearchHotelsInput = z.object({
  destination: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .optional()
    .describe('City, region or country in plain words, e.g. "Lisbon", "Tyrol, Austria" or "Charleston SC"'),
  near: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      radiusKm: z.number().min(0.1).max(200).default(10),
    })
    .optional()
    .describe('Alternative to destination: hotels within radiusKm of a point'),
  checkIn: LocalDate.optional().describe(
    'Arrival date (YYYY-MM-DD). With checkOut, results include live prices.',
  ),
  checkOut: LocalDate.optional().describe('Departure date (YYYY-MM-DD)'),
  adults: z.number().int().min(1).max(10).default(2),
  childrenAges: ChildrenAges,
  mustHave: z
    .array(Phrase)
    .max(10)
    .default([])
    .describe(
      'Hard requirements in plain words, e.g. ["sauna", "dog friendly", "free parking", "bathtub"]. Hotels that have not confirmed all of them are excluded.',
    ),
  niceToHave: z
    .array(Phrase)
    .max(10)
    .default([])
    .describe('Soft preferences in plain words that improve ranking, e.g. ["spa", "rooftop bar"]'),
  preferences: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe(
      'The kind of stay in a sentence, e.g. "quiet romantic hideaway with mountain views". Used for semantic matching. Never include names or contact details.',
    ),
  budgetPerNight: z
    .object({
      amount: z.number().positive().max(1_000_000).describe('Major currency units: 250 means €250.00'),
      currency: CurrencyCode,
    })
    .optional()
    .describe('Maximum all-in price per night'),
  limit: z.number().int().min(1).max(10).default(5),
});
export type SearchHotelsInput = z.infer<typeof SearchHotelsInput>;

export const OfferSummaryDto = z.object({
  offerId: z.uuid().describe('Pass to create_hold, or call get_offers for every option'),
  roomType: z.string(),
  ratePlan: z.string(),
  includes: z.array(z.string()),
  total: DisplayMoney.describe('All-in price for the whole stay'),
  perNight: DisplayMoney,
  paymentMode: PaymentModeSchema,
  cancellation: z.string(),
  expiresAt: z.iso.datetime(),
});

export const HotelSummaryDto = z.object({
  hotelId: z.uuid(),
  name: z.string(),
  summary: z.string().nullable(),
  location: z.object({
    city: z.string().nullable(),
    region: z.string().nullable(),
    countryCode: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
  }),
  profileUrl: z.string(),
  rank: z.number().int(),
  score: z.number().describe('0–1; only meaningful relative to the other results'),
  why: z.array(z.string()).describe('Plain-language reasons for this result, safe to show to the traveller'),
  matched: z.object({ mustHave: z.array(z.string()), niceToHave: z.array(z.string()) }),
  cheapestOffer: OfferSummaryDto.nullable().describe('Present when dates were given'),
});
export type HotelSummaryDto = z.infer<typeof HotelSummaryDto>;

const Interpreted = z.object({ input: z.string(), label: z.string(), codes: z.array(z.string()) });

export const SearchHotelsResult = z.object({
  searchId: z.uuid(),
  results: z.array(HotelSummaryDto),
  interpreted: z.object({
    mustHave: z.array(Interpreted),
    niceToHave: z.array(Interpreted),
    treatedAsPreferences: z
      .array(z.string())
      .describe('Requirements not in our vocabulary; used for semantic matching instead of filtering'),
  }),
  excludedCount: z
    .number()
    .int()
    .describe('Hotels in the destination that did not meet the hard requirements'),
  notes: z.array(z.string()),
});
export type SearchHotelsResult = z.infer<typeof SearchHotelsResult>;

export const GetHotelInput = z.object({
  hotelId: z.string().min(1).max(120).describe('hotelId from search_hotels (or the hotel’s slug)'),
});

export const GetHotelResult = z.object({ hotel: HotelProfileDto });

export const GetOffersInput = z.object({
  hotelId: z.uuid(),
  checkIn: LocalDate,
  checkOut: LocalDate,
  adults: z.number().int().min(1).max(10).default(2),
  childrenAges: ChildrenAges,
});
export type GetOffersInput = z.infer<typeof GetOffersInput>;

export const GetOffersResult = z.object({
  hotelId: z.uuid(),
  hotelName: z.string(),
  offers: z.array(OfferDto),
  notes: z.array(z.string()),
});

export const CreateHoldInput = z.object({
  offerId: z.uuid().describe('offerId from get_offers or search_hotels'),
});

export const HoldIdInput = z.object({ holdId: z.uuid() });

export const HoldStatusSchema = z
  .enum(['active', 'processing', 'confirmed', 'failed', 'expired', 'cancelled'])
  .describe(
    'active: waiting for the guest to check out. processing: payment received, reservation being created. confirmed: booked. failed/expired/cancelled: no booking.',
  );

export const HoldDto = z.object({
  holdId: z.uuid(),
  status: HoldStatusSchema,
  expiresAt: z.iso.datetime().describe('The guest must complete checkout before this time'),
  checkoutUrl: z
    .string()
    .nullable()
    .describe(
      'Secure page where the guest enters their details and pays. Null once the hold is no longer active.',
    ),
  hotel: z.object({ id: z.uuid(), name: z.string() }),
  roomType: z.string(),
  ratePlan: z.string(),
  checkIn: LocalDate,
  checkOut: LocalDate,
  adults: z.number().int(),
  childrenAges: z.array(z.number().int()),
  paymentMode: PaymentModeSchema,
  total: DisplayMoney,
  dueNow: DisplayMoney,
  dueAtHotel: DisplayMoney,
  booking: z
    .object({ confirmationNumber: z.string() })
    .nullable()
    .describe('Present once the reservation is confirmed'),
  nextStep: z.string().describe('What to tell the traveller now'),
});
export type HoldDto = z.infer<typeof HoldDto>;
