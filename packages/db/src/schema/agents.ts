import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, id, tstz } from './common';

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
