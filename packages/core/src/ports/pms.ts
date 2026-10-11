import type { Money } from '@lodgent/shared';

/**
 * Port for property-management systems. Apaleo is the first adapter; Mews or Cloudbeds would
 * implement the same interface. All amounts are integer minor units, all stay dates property-local.
 */

export type GuaranteeType = 'none' | 'credit_card' | 'prepayment' | 'company';

export interface PmsTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string | null;
}

export interface PmsAccount {
  accountCode: string;
  accountName: string | null;
}

export interface PmsAddress {
  line1: string | null;
  line2: string | null;
  postalCode: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
}

export interface PmsProperty {
  pmsId: string;
  code: string;
  name: string;
  description: string | null;
  address: PmsAddress;
  timeZone: string;
  currency: string;
  isLive: boolean;
}

export interface PmsRoomType {
  pmsId: string;
  pmsPropertyId: string;
  code: string;
  name: string;
  description: string | null;
  maxOccupancy: number | null;
  unitCount: number;
}

export interface PmsCancellationPolicy {
  pmsId: string;
  code: string | null;
  name: string | null;
  description: string | null;
}

export interface PmsRatePlan {
  pmsId: string;
  pmsPropertyId: string;
  pmsRoomTypeId: string;
  code: string;
  name: string;
  description: string | null;
  minGuarantee: GuaranteeType;
  channelCodes: string[];
  isBookable: boolean;
  cancellationPolicy: PmsCancellationPolicy | null;
  includedServices: { code: string | null; name: string; description: string | null }[];
}

export interface OfferQuery {
  pmsPropertyId: string;
  arrival: string;
  departure: string;
  adults: number;
  childrenAges: number[];
}

export interface PmsOfferLine {
  label: string;
  amount: Money;
}

/** A bookable offer with the all-in price a guest will pay (accommodation, taxes, mandatory fees). */
export interface PmsOffer {
  pmsRoomTypeId: string;
  roomTypeName: string;
  pmsRatePlanId: string;
  ratePlanName: string;
  ratePlanDescription: string | null;
  minGuarantee: GuaranteeType;
  availableUnits: number;
  /** Everything the guest pays for the stay. */
  total: Money;
  /** Accommodation incl. VAT and included services, before city tax and add-on fees. */
  accommodation: Money;
  /** VAT already contained in `accommodation`. */
  includedTaxes: Money;
  /** City/tourist tax, mandatory fees and mandatory services added on top of accommodation. */
  extras: PmsOfferLine[];
  /** Amount due at booking according to the rate plan (prepayment). */
  prepayment: Money;
  nightly: { date: string; amount: Money }[];
  cancellation: {
    code: string | null;
    name: string | null;
    description: string | null;
    /** Instant after which the cancellation fee applies; null when the fee applies immediately. */
    freeUntil: Date | null;
    fee: Money;
  };
  noShowFee: Money | null;
}

export interface CreateReservationInput {
  pmsPropertyId: string;
  pmsRatePlanId: string;
  arrival: string;
  departure: string;
  adults: number;
  childrenAges: number[];
  guest: { firstName: string; lastName: string; email: string; phone: string | null };
  specialRequests: string | null;
  /** Per-night gross amounts locked at quote time. */
  nightly: { amount: Money }[];
  guarantee: GuaranteeType;
  /** Our booking reference, stored in the PMS for cross-reference. */
  externalCode: string;
  /** Internal note for the hotel (payment reference etc.). */
  comment: string;
  idempotencyKey: string;
}

export interface PmsReservation {
  pmsBookingId: string;
  pmsReservationId: string;
  /** What the hotel and guest call the booking (Apaleo: the reservation id). */
  confirmationNumber: string;
  status: 'confirmed' | 'in_house' | 'checked_out' | 'cancelled' | 'no_show';
}

export interface RecordPaymentInput {
  pmsReservationId: string;
  amount: Money;
  /** Payment-provider reference, e.g. the Stripe PaymentIntent id. */
  reference: string;
  idempotencyKey: string;
}

/** API client bound to one connected PMS account. */
export interface PmsClient {
  getAccount(): Promise<PmsAccount>;
  listProperties(): Promise<PmsProperty[]>;
  listRoomTypes(pmsPropertyId: string): Promise<PmsRoomType[]>;
  listRatePlans(pmsPropertyId: string): Promise<PmsRatePlan[]>;
  getOffers(query: OfferQuery): Promise<PmsOffer[]>;
  createReservation(input: CreateReservationInput): Promise<PmsReservation>;
  getReservation(pmsReservationId: string): Promise<PmsReservation | null>;
  cancelReservation(pmsReservationId: string): Promise<void>;
  recordPayment(input: RecordPaymentInput): Promise<void>;
  subscribeWebhooks(endpointUrl: string, pmsPropertyIds: string[]): Promise<string>;
  unsubscribeWebhooks(subscriptionId: string): Promise<void>;
}

/** Provider-level operations (OAuth) and a factory for account-bound clients. */
export interface PmsProvider {
  readonly name: 'apaleo';
  authorizeUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<PmsTokens>;
  refresh(refreshToken: string): Promise<PmsTokens>;
  revoke(refreshToken: string): Promise<void>;
  /** `getAccessToken` is called before each request; it handles refresh and storage. */
  client(getAccessToken: () => Promise<string>): PmsClient;
}

/** Which rate plans an agent may book and how the guest pays. */
export function paymentModeFor(guarantee: GuaranteeType): 'prepaid' | 'pay_at_hotel' | null {
  if (guarantee === 'prepayment') return 'prepaid';
  if (guarantee === 'credit_card' || guarantee === 'none') return 'pay_at_hotel';
  return null; // company rates need a contract; never sold to agents
}
