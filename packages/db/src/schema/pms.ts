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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, tstz, updatedAt } from './common';
import { organizations, properties, users } from './tenancy';

export const pmsConnectionStatus = pgEnum('pms_connection_status', ['active', 'error', 'revoked']);
export const guaranteeType = pgEnum('guarantee_type', ['none', 'credit_card', 'prepayment', 'company']);
export const paymentMode = pgEnum('payment_mode', ['prepaid', 'pay_at_hotel']);
export const policyKind = pgEnum('policy_kind', [
  'cancellation',
  'no_show',
  'pets',
  'parking',
  'check_in_out',
  'children',
  'accessibility',
  'other',
]);
export const policySource = pgEnum('policy_source', ['pms', 'hotel']);

/** One connected PMS account per organization. OAuth tokens are KMS envelope-encrypted. */
export const pmsConnections = pgTable(
  'pms_connections',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('apaleo'),
    accountCode: text('account_code').notNull(),
    accountName: text('account_name'),
    status: pmsConnectionStatus('status').notNull().default('active'),
    scopes: text('scopes'),
    /** Envelope-encrypted JSON `{ accessToken, refreshToken }`. */
    encryptedTokens: text('encrypted_tokens').notNull(),
    accessTokenExpiresAt: tstz('access_token_expires_at').notNull(),
    webhookSubscriptionId: text('webhook_subscription_id'),
    lastSyncAt: tstz('last_sync_at'),
    lastSyncStatus: text('last_sync_status'),
    lastSyncError: text('last_sync_error'),
    lastSyncStats: jsonb('last_sync_stats').$type<Record<string, number>>(),
    connectedByUserId: uuid('connected_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('pms_connections_org_provider_idx').on(t.organizationId, t.provider),
    index('pms_connections_account_idx').on(t.provider, t.accountCode),
  ],
);

/** A room category (Apaleo unit group). */
export const roomTypes = pgTable(
  'room_types',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    pmsId: text('pms_id'),
    code: text('code'),
    name: text('name').notNull(),
    description: text('description'),
    maxOccupancy: integer('max_occupancy'),
    unitCount: integer('unit_count'),
    photos: jsonb('photos').$type<{ url: string; caption?: string }[]>().notNull().default([]),
    /** Last values imported from the PMS; fields still equal to these are refreshed on sync. */
    pmsSnapshot: jsonb('pms_snapshot').$type<Record<string, unknown>>(),
    archivedAt: tstz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('room_types_property_idx').on(t.propertyId),
    uniqueIndex('room_types_property_pms_idx').on(t.propertyId, t.pmsId).where(sql`${t.pmsId} is not null`),
  ],
);

export const ratePlans = pgTable(
  'rate_plans',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),
    pmsId: text('pms_id'),
    code: text('code'),
    name: text('name').notNull(),
    description: text('description'),
    minGuarantee: guaranteeType('min_guarantee').notNull(),
    /** Derived from the guarantee; null for rate plans that can never be sold to agents (company rates). */
    paymentMode: paymentMode('payment_mode'),
    channelCodes: text('channel_codes').array().notNull().default(sql`'{}'::text[]`),
    isBookable: boolean('is_bookable').notNull().default(true),
    /** The hotel's explicit opt-in to selling this rate plan through agents. */
    exposedToAgents: boolean('exposed_to_agents').notNull().default(false),
    cancellationPolicyId: uuid('cancellation_policy_id'),
    includedServices: jsonb('included_services')
      .$type<{ code: string | null; name: string; description: string | null }[]>()
      .notNull()
      .default([]),
    archivedAt: tstz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('rate_plans_property_idx').on(t.propertyId),
    uniqueIndex('rate_plans_property_pms_idx').on(t.propertyId, t.pmsId).where(sql`${t.pmsId} is not null`),
  ],
);

/** Hotel policies: cancellation (from the PMS) and house rules (pets, parking, children…). */
export const policies = pgTable(
  'policies',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    kind: policyKind('kind').notNull(),
    source: policySource('source').notNull(),
    pmsId: text('pms_id'),
    code: text('code'),
    title: text('title').notNull(),
    description: text('description'),
    data: jsonb('data').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('policies_property_idx').on(t.propertyId),
    uniqueIndex('policies_property_pms_idx')
      .on(t.propertyId, t.kind, t.pmsId)
      .where(sql`${t.pmsId} is not null`),
  ],
);

/**
 * A priced offer returned to an agent. Doubles as the short-TTL offer cache (same query key within
 * OFFER_CACHE_TTL_SECONDS) and as the quote a hold is created from (valid until `expiresAt`).
 */
export const offerQuotes = pgTable(
  'offer_quotes',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id')
      .notNull()
      .references(() => roomTypes.id, { onDelete: 'cascade' }),
    ratePlanId: uuid('rate_plan_id')
      .notNull()
      .references(() => ratePlans.id, { onDelete: 'cascade' }),
    queryKey: text('query_key').notNull(),
    arrival: date('arrival').notNull(),
    departure: date('departure').notNull(),
    adults: integer('adults').notNull(),
    childrenAges: integer('children_ages').array().notNull().default(sql`'{}'::int[]`),
    currency: text('currency').notNull(),
    totalAmount: bigint('total_amount', { mode: 'number' }).notNull(),
    paymentMode: paymentMode('payment_mode').notNull(),
    availableUnits: integer('available_units').notNull(),
    /** Accommodation, included taxes, extras, nightly amounts, cancellation terms (minor units). */
    details: jsonb('details').$type<OfferQuoteDetails>().notNull(),
    createdAt: createdAt(),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [
    index('offer_quotes_lookup_idx').on(t.propertyId, t.queryKey, t.createdAt),
    index('offer_quotes_expiry_idx').on(t.expiresAt),
  ],
);

export interface OfferQuoteDetails {
  roomTypeName: string;
  ratePlanName: string;
  ratePlanDescription: string | null;
  pmsRatePlanId: string;
  minGuarantee: 'none' | 'credit_card' | 'prepayment' | 'company';
  accommodation: { amount: number; currency: string };
  includedTaxes: { amount: number; currency: string };
  extras: { label: string; amount: { amount: number; currency: string } }[];
  prepayment: { amount: number; currency: string };
  nightly: { date: string; amount: { amount: number; currency: string } }[];
  cancellation: {
    code: string | null;
    name: string | null;
    description: string | null;
    freeUntil: string | null;
    fee: { amount: number; currency: string };
  };
  noShowFee: { amount: number; currency: string } | null;
}

/** Inbound webhook de-duplication (Stripe, Apaleo). System-only. */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: id(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    receivedAt: createdAt(),
    processedAt: tstz('processed_at'),
  },
  (t) => [uniqueIndex('webhook_events_provider_event_idx').on(t.provider, t.eventId)],
);
