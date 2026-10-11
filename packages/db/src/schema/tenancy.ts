import { sql } from 'drizzle-orm';
import {
  bigserial,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, tstz, updatedAt } from './common';

export const membershipRole = pgEnum('membership_role', ['owner', 'admin', 'viewer']);
export const propertyStatus = pgEnum('property_status', ['draft', 'published', 'unpublished']);
export const actorType = pgEnum('actor_type', ['user', 'system']);

/** A hotel group. Every tenant-owned row references one. */
export const organizations = pgTable('organizations', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  billingEmail: text('billing_email'),
  /** Customer on the platform's Stripe account, used to invoice pay-at-hotel fees. */
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable('users', {
  id: id(),
  /** `<provider>:<subject>`, e.g. `cognito:8f1c…` or `dev:alice@example.com`. */
  authSubject: text('auth_subject').notNull().unique(),
  email: text('email').notNull().unique(),
  name: text('name'),
  createdAt: createdAt(),
  lastLoginAt: tstz('last_login_at'),
});

export const memberships = pgTable(
  'memberships',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: membershipRole('role').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId] }), index('memberships_user_idx').on(t.userId)],
);

export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: membershipRole('role').notNull(),
    /** SHA-256 of the token in the invitation link; the token itself is never stored. */
    tokenHash: text('token_hash').notNull().unique(),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: tstz('expires_at').notNull(),
    acceptedAt: tstz('accepted_at'),
    acceptedByUserId: uuid('accepted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: tstz('revoked_at'),
    createdAt: createdAt(),
  },
  (t) => [index('invitations_org_idx').on(t.organizationId)],
);

/** A hotel. Maps to an Apaleo property when connected. */
export const properties = pgTable(
  'properties',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Globally unique; used in public profile URLs and accepted as an agent-facing hotel ID. */
    slug: text('slug').notNull().unique(),
    status: propertyStatus('status').notNull().default('draft'),
    description: text('description'),
    websiteUrl: text('website_url'),
    email: text('email'),
    phone: text('phone'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    postalCode: text('postal_code'),
    region: text('region'),
    countryCode: text('country_code'),
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    timeZone: text('time_zone').notNull().default('UTC'),
    currency: text('currency').notNull().default('EUR'),
    checkInTime: text('check_in_time'),
    checkOutTime: text('check_out_time'),
    /** Booking fee in basis points; 200 = 2%. */
    feeBps: integer('fee_bps').notNull().default(200),
    brandColor: text('brand_color'),
    logoUrl: text('logo_url'),
    photos: jsonb('photos').$type<{ url: string; caption?: string }[]>().notNull().default([]),
    pmsConnectionId: uuid('pms_connection_id'),
    pmsPropertyId: text('pms_property_id'),
    publishedAt: tstz('published_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('properties_org_idx').on(t.organizationId),
    uniqueIndex('properties_org_pms_idx')
      .on(t.organizationId, t.pmsPropertyId)
      .where(sql`${t.pmsPropertyId} is not null`),
    index('properties_status_idx').on(t.status),
  ],
);

/** Every hotel-side change. Append-only. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actorType: actorType('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    changes: jsonb('changes').$type<Record<string, unknown>>(),
    requestId: text('request_id'),
    createdAt: createdAt(),
  },
  (t) => [index('audit_logs_org_created_idx').on(t.organizationId, t.createdAt)],
);

/**
 * Transactional outbox: side effects (emails, jobs) are written in the same transaction as the
 * change that causes them, then dispatched by the worker.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    topic: text('topic').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** Optional de-duplication key; a second insert with the same key is ignored. */
    dedupeKey: text('dedupe_key').unique(),
    availableAt: tstz('available_at').notNull().defaultNow(),
    dispatchedAt: tstz('dispatched_at'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [index('outbox_pending_idx').on(t.availableAt).where(sql`${t.dispatchedAt} is null`)],
);

/** Postgres-backed job queue used locally and in tests (SQS in AWS). */
export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    dedupeKey: text('dedupe_key').unique(),
    runAt: tstz('run_at').notNull().defaultNow(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    lockedUntil: tstz('locked_until'),
    lastError: text('last_error'),
    completedAt: tstz('completed_at'),
    failedAt: tstz('failed_at'),
    createdAt: createdAt(),
  },
  (t) => [index('jobs_ready_idx').on(t.runAt).where(sql`${t.completedAt} is null and ${t.failedAt} is null`)],
);
