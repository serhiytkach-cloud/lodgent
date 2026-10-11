import { sql } from 'drizzle-orm';
import { boolean, index, integer, numeric, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, id, tstz, updatedAt } from './common';
import { organizations, properties } from './tenancy';

/** Per-organization monitor settings (cost cap). Created on first use. */
export const visibilitySettings = pgTable('visibility_settings', {
  id: id(),
  organizationId: uuid('organization_id')
    .notNull()
    .unique()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(true),
  monthlyCapCents: integer('monthly_cap_cents').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const visibilityQuerySource = pgEnum('visibility_query_source', ['suggested', 'hotel']);

/** Questions travellers ask assistants that a property should show up in. */
export const visibilityQueries = pgTable(
  'visibility_queries',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    source: visibilityQuerySource('source').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('visibility_queries_property_idx').on(t.propertyId)],
);

export const visibilityRunStatus = pgEnum('visibility_run_status', [
  'queued',
  'running',
  'completed',
  'capped',
  'failed',
]);

export const visibilityRuns = pgTable(
  'visibility_runs',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    trigger: text('trigger').notNull(),
    status: visibilityRunStatus('status').notNull().default('queued'),
    costCents: numeric('cost_cents', { precision: 10, scale: 2, mode: 'number' }).notNull().default(0),
    questions: integer('questions').notNull().default(0),
    error: text('error'),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('visibility_runs_property_idx').on(t.propertyId, t.createdAt),
    index('visibility_runs_org_month_idx').on(t.organizationId, t.createdAt),
  ],
);

/** One assistant's answer to one question in a run, analysed. */
export const visibilityResults = pgTable(
  'visibility_results',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => visibilityRuns.id, { onDelete: 'cascade' }),
    propertyId: uuid('property_id')
      .notNull()
      .references(() => properties.id, { onDelete: 'cascade' }),
    queryId: uuid('query_id').references(() => visibilityQueries.id, { onDelete: 'set null' }),
    queryText: text('query_text').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    simulated: boolean('simulated').notNull().default(false),
    status: text('status').notNull(),
    error: text('error'),
    mentioned: boolean('mentioned').notNull().default(false),
    rank: integer('rank'),
    listSize: integer('list_size').notNull().default(0),
    competitors: text('competitors').array().notNull().default(sql`'{}'::text[]`),
    citedUrls: text('cited_urls').array().notNull().default(sql`'{}'::text[]`),
    ownSiteCited: boolean('own_site_cited').notNull().default(false),
    profileCited: boolean('profile_cited').notNull().default(false),
    excerpt: text('excerpt'),
    /** Full answer, kept for VISIBILITY_RAW_RETENTION_DAYS then purged. */
    rawAnswer: text('raw_answer'),
    costCents: numeric('cost_cents', { precision: 10, scale: 2, mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('visibility_results_run_idx').on(t.runId),
    index('visibility_results_property_idx').on(t.propertyId, t.createdAt),
  ],
);
