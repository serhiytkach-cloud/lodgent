import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentChannel, agentClients } from './agents';
import { createdAt, id, tstz, updatedAt } from './common';
import { type OfferQuoteDetails, offerQuotes, paymentMode, ratePlans, roomTypes } from './pms';
import { organizations, properties } from './tenancy';

export const holdStatus = pgEnum('hold_status', [
  'active',
  'processing',
  'confirmed',
  'failed',
  'expired',
  'cancelled',
]);

/**
 * A room held in Lodgent (not in the PMS) for a guest to complete checkout. Created by an agent from
 * an offer quote; the price, payment mode and fee are frozen here. No guest data until checkout.
 */
export const holds = pgTable(
  'holds',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    offerQuoteId: uuid('offer_quote_id').references(() => offerQuotes.id, { onDelete: 'set null' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'restrict' }),
    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id, { onDelete: 'restrict' }),
    agentClientId: uuid('agent_client_id').references(() => agentClients.id, { onDelete: 'set null' }),
    channel: agentChannel('channel').notNull(),
    clientName: text('client_name'),
    arrival: date('arrival').notNull(),
    departure: date('departure').notNull(),
    adults: integer('adults').notNull(),
    childrenAges: integer('children_ages').array().notNull().default(sql`'{}'::int[]`),
    currency: text('currency').notNull(),
    totalAmount: bigint('total_amount', { mode: 'number' }).notNull(),
    dueNowAmount: bigint('due_now_amount', { mode: 'number' }).notNull(),
    paymentMode: paymentMode('payment_mode').notNull(),
    feeBps: integer('fee_bps').notNull(),
    feeAmount: bigint('fee_amount', { mode: 'number' }).notNull(),
    /** The quote as offered (names, price breakdown, cancellation terms); quotes themselves are purged. */
    offer: jsonb('offer').$type<OfferQuoteDetails>().notNull(),
    status: holdStatus('status').notNull().default('active'),
    statusReason: text('status_reason'),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('holds_property_idx').on(t.propertyId, t.createdAt),
    index('holds_active_idx')
      .on(t.roomTypeId, t.arrival, t.departure)
      .where(sql`status in ('active', 'processing')`),
    index('holds_expiry_idx').on(t.expiresAt).where(sql`status = 'active'`),
  ],
);

export const paymentAccountStatus = pgEnum('payment_account_status', ['onboarding', 'active', 'restricted']);

/** The hotel group's Stripe connected account (one per organization). */
export const paymentAccounts = pgTable('payment_accounts', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .unique()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('stripe'),
  accountId: text('account_id').notNull().unique(),
  status: paymentAccountStatus('status').notNull().default('onboarding'),
  chargesEnabled: boolean('charges_enabled').notNull().default(false),
  payoutsEnabled: boolean('payouts_enabled').notNull().default(false),
  detailsSubmitted: boolean('details_submitted').notNull().default(false),
  country: text('country'),
  defaultCurrency: text('default_currency'),
  requirementsDue: text('requirements_due').array().notNull().default(sql`'{}'::text[]`),
  connectedByUserId: uuid('connected_by_user_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const bookingStatus = pgEnum('booking_status', [
  'pending_payment',
  'reserving',
  'confirmed',
  'failed',
  'cancelled',
]);

/**
 * A guest's booking from a hold. Holds the minimum guest data the hotel needs (name, email, phone,
 * requests), which the retention job redacts after the stay. Payment state mirrors the provider.
 */
export const bookings = pgTable(
  'bookings',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    holdId: uuid('hold_id')
      .notNull()
      .unique()
      .references(() => holds.id, { onDelete: 'restrict' }),
    reference: text('reference').notNull().unique(),
    status: bookingStatus('status').notNull().default('pending_payment'),
    statusReason: text('status_reason'),
    paymentMode: paymentMode('payment_mode').notNull(),
    currency: text('currency').notNull(),
    totalAmount: bigint('total_amount', { mode: 'number' }).notNull(),
    dueNowAmount: bigint('due_now_amount', { mode: 'number' }).notNull(),
    feeBps: integer('fee_bps').notNull(),
    feeAmount: bigint('fee_amount', { mode: 'number' }).notNull(),
    arrival: date('arrival').notNull(),
    departure: date('departure').notNull(),
    adults: integer('adults').notNull(),
    childrenAges: integer('children_ages').array().notNull().default(sql`'{}'::int[]`),
    roomTypeId: uuid('room_type_id').notNull(),
    ratePlanId: uuid('rate_plan_id').notNull(),
    agentClientId: uuid('agent_client_id').references(() => agentClients.id, { onDelete: 'set null' }),
    channel: agentChannel('channel').notNull(),
    // Guest data (PII): minimum needed for the reservation; redacted by the retention job.
    guestFirstName: text('guest_first_name'),
    guestLastName: text('guest_last_name'),
    guestEmail: text('guest_email'),
    guestPhone: text('guest_phone'),
    specialRequests: text('special_requests'),
    termsAcceptedAt: tstz('terms_accepted_at'),
    piiRedactedAt: tstz('pii_redacted_at'),
    // Payment (Stripe ids on the hotel's connected account).
    paymentAccountId: text('payment_account_id').notNull(),
    paymentIntentId: text('payment_intent_id'),
    setupIntentId: text('setup_intent_id'),
    paymentStatus: text('payment_status').notNull().default('none'),
    // PMS reservation.
    pmsBookingId: text('pms_booking_id'),
    pmsReservationId: text('pms_reservation_id'),
    confirmationNumber: text('confirmation_number'),
    pmsStatus: text('pms_status'),
    folioPaymentRecordedAt: tstz('folio_payment_recorded_at'),
    confirmedAt: tstz('confirmed_at'),
    cancelledAt: tstz('cancelled_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('bookings_property_idx').on(t.propertyId, t.createdAt),
    index('bookings_status_idx').on(t.status, t.updatedAt),
    index('bookings_pms_reservation_idx').on(t.pmsReservationId),
  ],
);

export const feeCollection = pgEnum('fee_collection', ['application_fee', 'invoice']);
export const feeStatus = pgEnum('fee_status', ['collected', 'pending', 'invoiced', 'void']);

/**
 * What the platform earns per booking. Prepaid bookings collect the fee as a Stripe application fee
 * at capture; pay-at-hotel fees accrue here and are invoiced monthly (M7).
 */
export const feeLedger = pgTable(
  'fee_ledger',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    bookingId: uuid('booking_id')
      .notNull()
      .unique()
      .references(() => bookings.id, { onDelete: 'restrict' }),
    collection: feeCollection('collection').notNull(),
    status: feeStatus('status').notNull(),
    feeBps: integer('fee_bps').notNull(),
    bookingTotalAmount: bigint('booking_total_amount', { mode: 'number' }).notNull(),
    amount: bigint('amount', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    invoiceId: text('invoice_id'),
    occurredAt: tstz('occurred_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('fee_ledger_org_idx').on(t.organizationId, t.occurredAt)],
);
