import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { createdAt, id, tstz, updatedAt } from './common';
import { roomTypes } from './pms';
import { organizations, properties, users } from './tenancy';

export const attributeSource = pgEnum('attribute_source', ['pms', 'website', 'hotel', 'ai_extracted']);
export const assignmentStatus = pgEnum('assignment_status', ['suggested', 'approved', 'rejected']);
export const crawlStatus = pgEnum('crawl_status', ['queued', 'running', 'succeeded', 'failed']);
export const embeddingKind = pgEnum('embedding_kind', ['property', 'room']);

/** The attribute vocabulary, upserted from @lodgent/taxonomy on startup. Global (not tenant-owned). */
export const attributeDefinitions = pgTable('attribute_definitions', {
  code: text('code').primaryKey(),
  label: text('label').notNull(),
  category: text('category').notNull(),
  appliesTo: text('applies_to').notNull(),
  importance: integer('importance').notNull(),
  valueType: text('value_type').notNull(),
  enumValues: text('enum_values').array(),
  deprecated: text('deprecated'),
  updatedAt: updatedAt(),
});

/**
 * A value for an attribute at property or room-type level, from one source, with provenance.
 * One row per (scope, attribute, source); the effective value is the latest approved one.
 */
export const attributeAssignments = pgTable(
  'attribute_assignments',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id').references(() => roomTypes.id, { onDelete: 'cascade' }),
    /** `property` or the room type id; makes the unique key work without NULL semantics. */
    scopeKey: text('scope_key').notNull(),
    attributeCode: text('attribute_code')
      .notNull()
      .references(() => attributeDefinitions.code, { onUpdate: 'cascade' }),
    value: jsonb('value').$type<boolean | number | string>().notNull(),
    source: attributeSource('source').notNull(),
    confidence: real('confidence').notNull(),
    status: assignmentStatus('status').notNull().default('suggested'),
    evidence: jsonb('evidence').$type<{ url: string; snippet: string }[]>().notNull().default([]),
    reviewedByUserId: uuid('reviewed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: tstz('reviewed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('attribute_assignments_unique_idx').on(t.propertyId, t.scopeKey, t.attributeCode, t.source),
    index('attribute_assignments_property_idx').on(t.propertyId, t.status),
    index('attribute_assignments_code_idx').on(t.attributeCode, t.status),
  ],
);

/** Suggested hotel/room descriptions from the website (reviewed like attributes). */
export const descriptionSuggestions = pgTable(
  'description_suggestions',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id').references(() => roomTypes.id, { onDelete: 'cascade' }),
    scopeKey: text('scope_key').notNull(),
    text: text('text').notNull(),
    source: attributeSource('source').notNull(),
    evidenceUrl: text('evidence_url'),
    status: assignmentStatus('status').notNull().default('suggested'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('description_suggestions_unique_idx').on(t.propertyId, t.scopeKey, t.source)],
);

/** Embeddings for natural-language matching (pgvector, cosine). */
export const embeddings = pgTable(
  'embeddings',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    roomTypeId: uuid('room_type_id').references(() => roomTypes.id, { onDelete: 'cascade' }),
    kind: embeddingKind('kind').notNull(),
    scopeKey: text('scope_key').notNull(),
    model: text('model').notNull(),
    contentHash: text('content_hash').notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 512 }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('embeddings_scope_idx').on(t.propertyId, t.scopeKey),
    index('embeddings_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

export const websiteCrawls = pgTable(
  'website_crawls',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    status: crawlStatus('status').notNull().default('queued'),
    requestedByUserId: uuid('requested_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
    pagesFetched: integer('pages_fetched').notNull().default(0),
    extractionModel: text('extraction_model'),
    stats: jsonb('stats').$type<Record<string, number>>(),
    error: text('error'),
    createdAt: createdAt(),
  },
  (t) => [index('website_crawls_property_idx').on(t.propertyId, t.createdAt)],
);

export const crawledPages = pgTable(
  'crawled_pages',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    crawlId: uuid('crawl_id')
      .notNull()
      .references(() => websiteCrawls.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    title: text('title'),
    text: text('text').notNull(),
    fetchedAt: createdAt(),
  },
  (t) => [index('crawled_pages_crawl_idx').on(t.crawlId)],
);
