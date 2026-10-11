import { sql } from 'drizzle-orm';
import { bigint, date, index, integer, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
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
