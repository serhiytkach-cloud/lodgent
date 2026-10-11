import { sql } from 'drizzle-orm';
import { boolean, date, index, integer, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, tstz } from './common';
import { organizations, properties } from './tenancy';

/**
 * A partner (agent platform, travel app) with an API key. Partners are global, not per hotel.
 * Only a SHA-256 of the key is stored; keys carry 256 bits of randomness, so a fast hash is safe.
 */
export const agentClients = pgTable('agent_clients', {
  id: id(),
  name: text('name').notNull(),
  contactEmail: text('contact_email'),
  /** First characters of the key, shown in admin tools to identify it. */
  keyPrefix: text('key_prefix').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  rateLimitPerMinute: integer('rate_limit_per_minute'),
  lastUsedAt: tstz('last_used_at'),
  revokedAt: tstz('revoked_at'),
  createdAt: createdAt(),
});

export const agentChannel = pgEnum('agent_channel', ['mcp', 'rest']);

/**
 * One agent request (search, hotel view, offers, hold). Deliberately holds no guest PII and no free
 * text: only interpreted attribute codes, coarse destination, dates and party size. System-only.
 */
export const agentQueries = pgTable(
  'agent_queries',
  {
    id: id(),
    agentClientId: uuid('agent_client_id').references(() => agentClients.id, { onDelete: 'set null' }),
    channel: agentChannel('channel').notNull(),
    clientName: text('client_name'),
    tool: text('tool').notNull(),
    destination: text('destination'),
    checkIn: date('check_in'),
    checkOut: date('check_out'),
    adults: integer('adults'),
    children: integer('children'),
    mustHaveCodes: text('must_have_codes').array().notNull().default(sql`'{}'::text[]`),
    niceToHaveCodes: text('nice_to_have_codes').array().notNull().default(sql`'{}'::text[]`),
    hasPreferences: boolean('has_preferences').notNull().default(false),
    resultCount: integer('result_count').notNull().default(0),
    latencyMs: integer('latency_ms'),
    utmSource: text('utm_source'),
    utmMedium: text('utm_medium'),
    utmCampaign: text('utm_campaign'),
    createdAt: createdAt(),
  },
  (t) => [index('agent_queries_created_idx').on(t.createdAt)],
);

export const agentEventKind = pgEnum('agent_event_kind', [
  'search_impression',
  'hotel_view',
  'offers_view',
  'hold_created',
]);

/** Per-hotel funnel events (tenant-owned, so each hotel sees its own). */
export const agentEvents = pgTable(
  'agent_events',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    queryId: uuid('query_id').references(() => agentQueries.id, { onDelete: 'set null' }),
    agentClientId: uuid('agent_client_id').references(() => agentClients.id, { onDelete: 'set null' }),
    channel: agentChannel('channel').notNull(),
    kind: agentEventKind('kind').notNull(),
    rank: integer('rank'),
    createdAt: createdAt(),
  },
  (t) => [index('agent_events_property_idx').on(t.propertyId, t.createdAt)],
);
