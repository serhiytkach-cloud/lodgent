import type { Clock } from '@lodgent/core';
import type { Database } from '@lodgent/db';
import { BRAND } from '@lodgent/shared';
import { hashToken, newToken } from './members';

interface CachedClient {
  value: { id: string; name: string; rateLimitPerMinute: number | null };
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 1_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;
/** Shape of a key minted by `create` (prefix, environment label, 256-bit random part). */
const ESCAPED_PREFIX = BRAND.apiKeyPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const KEY_FORMAT = new RegExp(`^${ESCAPED_PREFIX}_[a-z]{2,10}_[A-Za-z0-9_-]{40,64}$`);

/** Whether a presented string can be a partner key at all (checked before any hashing or lookup). */
export function isWellFormedApiKey(key: string): boolean {
  return KEY_FORMAT.test(key);
}

/**
 * Partner API keys for agent attribution and higher rate limits. Keys carry 256 random bits, so a
 * fast hash (SHA-256) is enough to store them; only the hash and a short display prefix are kept.
 * Valid keys are cached briefly (revocation takes effect on other API instances within the cache
 * TTL); unknown keys are never cached, so random keys can't grow the cache.
 */
export class AgentClientService {
  private readonly cache = new Map<string, CachedClient>();
  private readonly touched = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  /** Creates a partner and returns its API key. The key is shown once and never stored. */
  async create(input: { name: string; contactEmail?: string | null }) {
    const key = `${BRAND.apiKeyPrefix}_live_${newToken(32)}`;
    const row = await this.db.system(({ agentClients }) =>
      agentClients.create({
        name: input.name,
        contactEmail: input.contactEmail ?? null,
        keyPrefix: key.slice(0, 18),
        keyHash: hashToken(key),
      }),
    );
    return { id: row.id, name: row.name, apiKey: key };
  }

  async verify(key: string) {
    if (!isWellFormedApiKey(key)) return null;
    const hash = hashToken(key);
    const now = this.clock.now().getTime();
    const cached = this.cache.get(hash);
    if (cached && cached.expiresAt > now) return cached.value;
    if (cached) this.cache.delete(hash);

    const row = await this.db.system(({ agentClients }) => agentClients.findActiveByHash(hash));
    const value = row ? { id: row.id, name: row.name, rateLimitPerMinute: row.rateLimitPerMinute } : null;
    if (value) {
      if (this.cache.size >= CACHE_MAX_ENTRIES) {
        // Map iteration order is insertion order: drop the oldest entry.
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(hash, { value, expiresAt: now + CACHE_TTL_MS });
    }
    if (row && (this.touched.get(row.id) ?? 0) < now - TOUCH_INTERVAL_MS) {
      this.touched.set(row.id, now);
      await this.db.system(({ agentClients }) => agentClients.touch(row.id, this.clock.now()));
    }
    return value;
  }

  async revoke(id: string) {
    this.cache.clear();
    return this.db.system(({ agentClients }) => agentClients.revoke(id, this.clock.now()));
  }

  async list() {
    return this.db.system(({ agentClients }) => agentClients.list());
  }
}
